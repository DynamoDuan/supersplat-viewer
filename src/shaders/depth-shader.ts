// Custom gsplatVS shader chunks with GSPLAT_DEPTH_VIZ support
// Adds turbo colormap depth visualization alongside existing GSPLAT_OVERDRAW

const depthGsplatVS = /* glsl */ `
#include "gsplatCommonVS"
varying mediump vec2 gaussianUV;
varying mediump vec4 gaussianColor;
#ifndef DITHER_NONE
	varying float id;
#endif
mediump vec4 discardVec = vec4(0.0, 0.0, 2.0, 1.0);
#ifdef PREPASS_PASS
	varying float vLinearDepth;
#endif
#ifdef GSPLAT_OVERDRAW
	uniform sampler2D colorRamp;
	uniform float colorRampIntensity;
#endif
#ifdef GSPLAT_DEPTH_VIZ
	vec3 turboColormap(float t) {
		const vec4 kRedVec4   = vec4(0.13572138, 4.61539260, -42.66032258, 132.13108234);
		const vec4 kGreenVec4 = vec4(0.09140261, 2.19418839, 4.84296658, -14.18503333);
		const vec4 kBlueVec4  = vec4(0.10667330, 12.64194608, -60.58204836, 110.36276771);
		const vec2 kRedVec2   = vec2(-152.94239396, 59.28637943);
		const vec2 kGreenVec2 = vec2(4.27729857, 2.82956604);
		const vec2 kBlueVec2  = vec2(-89.90310912, 27.34824973);
		t = clamp(t, 0.0, 1.0);
		vec4 v4 = vec4(1.0, t, t * t, t * t * t);
		vec2 v2 = v4.zw * v4.z;
		return vec3(
			dot(v4, kRedVec4) + dot(v2, kRedVec2),
			dot(v4, kGreenVec4) + dot(v2, kGreenVec2),
			dot(v4, kBlueVec4) + dot(v2, kBlueVec2)
		);
	}
#endif
void main(void) {
	SplatSource source;
	if (!initSource(source)) {
		gl_Position = discardVec;
		return;
	}
	vec3 modelCenter = readCenter(source);
	SplatCenter center;
	center.modelCenterOriginal = modelCenter;

	modifyCenter(modelCenter);
	modifySplatCenter(modelCenter);
	center.modelCenterModified = modelCenter;
	if (!initCenter(modelCenter, center)) {
		gl_Position = discardVec;
		return;
	}
	SplatCorner corner;
	if (!initCorner(source, center, corner)) {
		gl_Position = discardVec;
		return;
	}
	vec4 clr = readColor(source);
	#if GSPLAT_AA
		clr.a *= corner.aaFactor;
	#endif
	#if SH_BANDS > 0
		vec3 dir = normalize(center.view * mat3(center.modelView));
		vec3 sh[SH_COEFFS];
		float scale;
		readSHData(source, sh, scale);
		clr.xyz += evalSH(sh, dir) * scale;
	#endif
	modifyColor(modelCenter, clr);
	modifySplatColor(modelCenter, clr);
	clipCorner(corner, clr.w);
	gl_Position = center.proj + vec4(corner.offset, 0, 0);
	gaussianUV = corner.uv;
	#ifdef GSPLAT_DEPTH_VIZ
		float depth = -center.view.z;
		float nd = 1.0 - clamp((depth - camera_params.z) / (camera_params.y - camera_params.z), 0.0, 1.0);
		gaussianColor = vec4(turboColormap(nd), clr.w);
	#elif defined(GSPLAT_OVERDRAW)
		float t = clamp(modelCenter.y / 20.0, 0.0, 1.0);
		vec3 rampColor = textureLod(colorRamp, vec2(t, 0.5), 0.0).rgb;
		clr.a *= (1.0 / 32.0) * colorRampIntensity;
		gaussianColor = vec4(rampColor, clr.a);
	#else
		gaussianColor = vec4(prepareOutputFromGamma(max(clr.xyz, 0.0)), clr.w);
	#endif
	#ifndef DITHER_NONE
		id = float(source.id);
	#endif
	#ifdef PREPASS_PASS
		vLinearDepth = -center.view.z;
	#endif
}
`;

const depthGsplatVS_WGSL = /* wgsl */ `
#include "gsplatCommonVS"
varying gaussianUV: vec2f;
varying gaussianColor: vec4f;
#ifndef DITHER_NONE
	varying id: f32;
#endif
const discardVec: vec4f = vec4f(0.0, 0.0, 2.0, 1.0);
#ifdef PREPASS_PASS
	varying vLinearDepth: f32;
#endif
#ifdef GSPLAT_OVERDRAW
	uniform colorRampIntensity: f32;
	var colorRamp: texture_2d<f32>;
	var colorRampSampler: sampler;
#endif
#ifdef GSPLAT_DEPTH_VIZ
	fn turboColormap(t_in: f32) -> vec3f {
		let kRedVec4   = vec4f(0.13572138, 4.61539260, -42.66032258, 132.13108234);
		let kGreenVec4 = vec4f(0.09140261, 2.19418839, 4.84296658, -14.18503333);
		let kBlueVec4  = vec4f(0.10667330, 12.64194608, -60.58204836, 110.36276771);
		let kRedVec2   = vec2f(-152.94239396, 59.28637943);
		let kGreenVec2 = vec2f(4.27729857, 2.82956604);
		let kBlueVec2  = vec2f(-89.90310912, 27.34824973);
		let t = clamp(t_in, 0.0, 1.0);
		let v4 = vec4f(1.0, t, t * t, t * t * t);
		let v2 = v4.zw * v4.z;
		return vec3f(
			dot(v4, kRedVec4) + dot(v2, kRedVec2),
			dot(v4, kGreenVec4) + dot(v2, kGreenVec2),
			dot(v4, kBlueVec4) + dot(v2, kBlueVec2)
		);
	}
#endif
@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
	var output: VertexOutput;
	var source: SplatSource;
	if (!initSource(&source)) {
		output.position = discardVec;
		return output;
	}
	var modelCenter: vec3f = readCenter(&source);
	var center: SplatCenter;
	center.modelCenterOriginal = modelCenter;

	modifyCenter(&modelCenter);
	modifySplatCenter(&modelCenter);
	center.modelCenterModified = modelCenter;
	if (!initCenter(modelCenter, &center)) {
		output.position = discardVec;
		return output;
	}
	var corner: SplatCorner;
	if (!initCorner(&source, &center, &corner)) {
		output.position = discardVec;
		return output;
	}
	var clr: vec4f = readColor(&source);
	#if GSPLAT_AA
		clr.a = clr.a * corner.aaFactor;
	#endif
	#if SH_BANDS > 0
		let modelView3x3 = mat3x3f(center.modelView[0].xyz, center.modelView[1].xyz, center.modelView[2].xyz);
		let dir = normalize(center.view * modelView3x3);
		var sh: array<vec3f, SH_COEFFS>;
		var scale: f32;
		readSHData(&source, &sh, &scale);
		clr = vec4f(clr.xyz + evalSH(&sh, dir) * scale, clr.a);
	#endif
	modifyColor(modelCenter, &clr);
	modifySplatColor(modelCenter, &clr);
	clipCorner(&corner, clr.w);
	output.position = center.proj + vec4f(corner.offset, 0.0, 0.0);
	output.gaussianUV = corner.uv;
	#ifdef GSPLAT_DEPTH_VIZ
		let depth: f32 = -center.view.z;
		let nd: f32 = 1.0 - clamp((depth - uniform.camera_params.z) / (uniform.camera_params.y - uniform.camera_params.z), 0.0, 1.0);
		output.gaussianColor = vec4f(turboColormap(nd), clr.w);
	#elif defined(GSPLAT_OVERDRAW)
		let t: f32 = clamp(originalCenter.y / 20.0, 0.0, 1.0);
		let rampColor: vec3f = textureSampleLevel(colorRamp, colorRampSampler, vec2f(t, 0.5), 0.0).rgb;
		clr.a = clr.a * (1.0 / 32.0) * uniform.colorRampIntensity;
		output.gaussianColor = vec4f(rampColor, clr.a);
	#else
		output.gaussianColor = vec4f(prepareOutputFromGamma(max(clr.xyz, vec3f(0.0))), clr.w);
	#endif
	#ifndef DITHER_NONE
		output.id = f32(source.id);
	#endif
	#ifdef PREPASS_PASS
		output.vLinearDepth = -center.view.z;
	#endif
	return output;
}
`;

export { depthGsplatVS, depthGsplatVS_WGSL };
