/**
 * PLY文件预处理器
 * 高斯PLY → 原样返回
 * 非高斯PLY（点云/mesh） → 补充高斯属性（不可见splat），用于centers overlay和选点
 */

interface PLYProperty {
    type: string;
    name: string;
}

interface PLYHeader {
    format: string;
    version: string;
    vertexCount: number;
    properties: PLYProperty[];
    headerEndByte: number;
}

const findHeaderEndByte = (buffer: ArrayBuffer): number => {
    const bytes = new Uint8Array(buffer);
    const target = new TextEncoder().encode('end_header\n');
    const maxSearch = Math.min(buffer.byteLength, 65536);

    for (let i = 0; i <= maxSearch - target.length; i++) {
        let match = true;
        for (let j = 0; j < target.length; j++) {
            if (bytes[i + j] !== target[j]) {
                match = false;
                break;
            }
        }
        if (match) return i + target.length;
    }
    return -1;
};

const parsePLYHeader = (buffer: ArrayBuffer): PLYHeader | null => {
    const headerEndByte = findHeaderEndByte(buffer);
    if (headerEndByte === -1) return null;

    const headerText = new TextDecoder('utf-8').decode(buffer.slice(0, headerEndByte));
    const lines = headerText.split('\n');

    let format = '';
    let version = '';
    let vertexCount = 0;
    const properties: PLYProperty[] = [];
    let inVertexElement = false;

    for (const line of lines) {
        const trimmed = line.trim();

        if (trimmed.startsWith('format')) {
            const parts = trimmed.split(/\s+/);
            format = parts[1] || '';
            version = parts[2] || '';
        } else if (trimmed.startsWith('element vertex')) {
            vertexCount = parseInt(trimmed.split(/\s+/)[2] || '0', 10);
            inVertexElement = true;
        } else if (trimmed.startsWith('element')) {
            inVertexElement = false;
        } else if (trimmed.startsWith('property') && inVertexElement) {
            const parts = trimmed.split(/\s+/);
            if (parts.length >= 3) {
                const type = parts[1] === 'list' ? 'list' : parts[1];
                const name = parts[parts.length - 1];
                properties.push({ type, name });
            }
        }
    }

    if (vertexCount === 0 || properties.length === 0) return null;

    return { format, version, vertexCount, properties, headerEndByte };
};

const getPLYTypeSize = (type: string): number => {
    switch (type) {
        case 'char': case 'uchar': case 'int8': case 'uint8': return 1;
        case 'short': case 'ushort': case 'int16': case 'uint16': return 2;
        case 'int': case 'uint': case 'int32': case 'uint32': case 'float': case 'float32': return 4;
        case 'double': case 'float64': return 8;
        default: return 4;
    }
};

const GAUSSIAN_COLOR_NAMES = ['red', 'green', 'blue', 'r', 'g', 'b', 'f_dc_0', 'f_dc_1', 'f_dc_2'];
const GAUSSIAN_OPACITY_NAMES = ['opacity', 'alpha'];

const hasGaussianProperties = (properties: PLYProperty[]): boolean => {
    const names = properties.map(p => p.name);
    return names.some(n => GAUSSIAN_COLOR_NAMES.includes(n)) &&
           names.some(n => GAUSSIAN_OPACITY_NAMES.includes(n)) &&
           names.some(n => n.startsWith('scale_')) &&
           names.some(n => n.startsWith('rot_'));
};

export interface PreprocessResult {
    buffer: ArrayBuffer;
    isPointCloud: boolean; // true = 非高斯PLY，需要自动开启centers overlay
}

/**
 * 预处理PLY文件
 * 高斯PLY → 原样返回 (isPointCloud=false)
 * 非高斯PLY → 补充不可见高斯属性+降采样 (isPointCloud=true)
 */
export const preprocessPLY = async (buffer: ArrayBuffer): Promise<PreprocessResult | null> => {
    const header = parsePLYHeader(buffer);
    if (!header) {
        console.warn('无法解析PLY文件头部');
        return null;
    }

    if (hasGaussianProperties(header.properties)) {
        console.log('PLY文件包含完整的高斯属性');
        return { buffer, isPointCloud: false };
    }

    if (!header.format.includes('binary')) {
        console.warn('ASCII PLY暂不支持');
        return null;
    }

    console.log(`非高斯PLY (${header.vertexCount}个顶点)，补充属性用于centers overlay...`);
    const converted = convertToGsplat(buffer, header);
    return { buffer: converted, isPointCloud: true };
};

// 降采样倍数
const DOWNSAMPLE = 3;

/**
 * 将普通点云PLY转换为gsplat格式（不可见splat，仅用于centers overlay和选点）
 */
const convertToGsplat = (buffer: ArrayBuffer, header: PLYHeader): ArrayBuffer => {
    const isLE = header.format.includes('little_endian');
    const srcBytes = new Uint8Array(buffer);

    const nonListProps = header.properties.filter(p => p.type !== 'list');
    const origVertexSize = nonListProps.reduce((s, p) => s + getPLYTypeSize(p.type), 0);

    const propertyNames = nonListProps.map(p => p.name);
    const needsColor = !propertyNames.some(n => GAUSSIAN_COLOR_NAMES.includes(n));
    const needsOpacity = !propertyNames.some(n => GAUSSIAN_OPACITY_NAMES.includes(n));
    const needsScale = !propertyNames.some(n => n.startsWith('scale_'));
    const needsRotation = !propertyNames.some(n => n.startsWith('rot_'));

    // 新属性列表
    const newProps: PLYProperty[] = [...nonListProps];
    if (needsColor) newProps.push({ type: 'float', name: 'f_dc_0' }, { type: 'float', name: 'f_dc_1' }, { type: 'float', name: 'f_dc_2' });
    if (needsOpacity) newProps.push({ type: 'float', name: 'opacity' });
    if (needsScale) newProps.push({ type: 'float', name: 'scale_0' }, { type: 'float', name: 'scale_1' }, { type: 'float', name: 'scale_2' });
    if (needsRotation) newProps.push({ type: 'float', name: 'rot_0' }, { type: 'float', name: 'rot_1' }, { type: 'float', name: 'rot_2' }, { type: 'float', name: 'rot_3' });

    let addedBytes = 0;
    if (needsColor) addedBytes += 12;
    if (needsOpacity) addedBytes += 4;
    if (needsScale) addedBytes += 12;
    if (needsRotation) addedBytes += 16;
    const newVertexSize = origVertexSize + addedBytes;

    const outputCount = Math.ceil(header.vertexCount / DOWNSAMPLE);

    // 构建头部（不含face元素）
    let hdr = 'ply\n';
    hdr += `format ${header.format} ${header.version}\n`;
    hdr += `element vertex ${outputCount}\n`;
    for (const p of newProps) hdr += `property ${p.type} ${p.name}\n`;
    hdr += 'end_header\n';

    const hdrBytes = new TextEncoder().encode(hdr);
    const outBuf = new ArrayBuffer(hdrBytes.length + outputCount * newVertexSize);
    const outBytes = new Uint8Array(outBuf);
    const outView = new DataView(outBuf);

    outBytes.set(hdrBytes, 0);

    // 默认值：opacity极低使splat不可见，但centers overlay能显示点
    const DC = 0.0;          // 灰色
    const OPACITY = -10.0;   // sigmoid(-10) ≈ 0.00005，被alphaClip裁掉，splat不渲染
    const SCALE = -7.0;      // 极小
    const ROT = [1.0, 0.0, 0.0, 0.0];

    let wp = hdrBytes.length;

    for (let i = 0; i < header.vertexCount; i += DOWNSAMPLE) {
        const rp = header.headerEndByte + i * origVertexSize;
        outBytes.set(srcBytes.subarray(rp, rp + origVertexSize), wp);
        wp += origVertexSize;

        if (needsColor) {
            outView.setFloat32(wp, DC, isLE); wp += 4;
            outView.setFloat32(wp, DC, isLE); wp += 4;
            outView.setFloat32(wp, DC, isLE); wp += 4;
        }
        if (needsOpacity) {
            outView.setFloat32(wp, OPACITY, isLE); wp += 4;
        }
        if (needsScale) {
            outView.setFloat32(wp, SCALE, isLE); wp += 4;
            outView.setFloat32(wp, SCALE, isLE); wp += 4;
            outView.setFloat32(wp, SCALE, isLE); wp += 4;
        }
        if (needsRotation) {
            outView.setFloat32(wp, ROT[0], isLE); wp += 4;
            outView.setFloat32(wp, ROT[1], isLE); wp += 4;
            outView.setFloat32(wp, ROT[2], isLE); wp += 4;
            outView.setFloat32(wp, ROT[3], isLE); wp += 4;
        }
    }

    console.log(`转换完成: ${header.vertexCount} → ${outputCount}个顶点 (${DOWNSAMPLE}x降采样)`);
    return outBuf;
};
