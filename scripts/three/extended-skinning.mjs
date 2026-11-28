// The bundled ESM renderer is the build served to Asset Viewer.
// GLTFLoader already exposes JOINTS_1 and WEIGHTS_1 as lowercase attributes.
const shader = value => JSON.stringify(value).slice(1, -1)
const extendShader = (before, after) => [shader(before), shader(after)]

const cpu = [
  ['normalizeSkinWeights() {\n\n\t\tconst vector = new Vector4();', `get hasExtraSkinWeights() {

		const { skinWeight, skinIndex, weights_1, joints_1 } = this.geometry.attributes;
		return skinWeight !== undefined && skinIndex !== undefined &&
			weights_1?.itemSize === 4 && joints_1?.itemSize === 4 &&
			weights_1.count === skinWeight.count && joints_1.count === skinIndex.count;

	}

	normalizeSkinWeights() {

		// Both groups must be normalized together. Leave their stored values intact.
		if ( this.hasExtraSkinWeights ) return;

		const vector = new Vector4();`],
  ['const _skinWeight = /*@__PURE__*/ new Vector4();', `const _skinWeight = /*@__PURE__*/ new Vector4();
const _extraSkinIndex = /*@__PURE__*/ new Vector4();
const _extraSkinWeight = /*@__PURE__*/ new Vector4();`],
  ['_skinWeight.fromBufferAttribute( geometry.attributes.skinWeight, index );',
    `_skinWeight.fromBufferAttribute( geometry.attributes.skinWeight, index );
		const hasExtra = this.hasExtraSkinWeights;
		if ( hasExtra ) {

			_extraSkinIndex.fromBufferAttribute( geometry.attributes.joints_1, index );
			_extraSkinWeight.fromBufferAttribute( geometry.attributes.weights_1, index );

		}`],
  [`for ( let i = 0; i < 4; i ++ ) {

			const weight = _skinWeight.getComponent( i );`, `let total = 0;
		for ( let i = 0; i < ( hasExtra ? 8 : 4 ); i ++ ) {

			const slot = i % 4;
			const weight = ( i < 4 ? _skinWeight : _extraSkinWeight ).getComponent( slot );`],
  ['const boneIndex = _skinIndex.getComponent( i );', `const boneIndex = ( i < 4 ? _skinIndex : _extraSkinIndex ).getComponent( slot );

				if ( hasExtra && ! skeleton.bones[ boneIndex ] ) continue;

				total += weight;`],
  [`if ( target.isVector4 ) {

			// ensure the homogenous coordinate remains unchanged after vector operations`, `if ( hasExtra ) {

			if ( total > 0 ) target.multiplyScalar( 1 / total );
			else target.copy( _baseVector );

		}

		if ( target.isVector4 ) {

			// ensure the homogenous coordinate remains unchanged after vector operations`],
]

const webgl = [
  ["parameters.skinning ? '#define USE_SKINNING' : '',",
    "parameters.skinning ? '#define USE_SKINNING' : '',\n\t\t\tparameters.extraSkinWeights ? '#define VIEWER_EXTRA_SKIN_WEIGHTS' : '',"],
  ['skinning: object.isSkinnedMesh === true,', 'skinning: object.isSkinnedMesh === true,\n\t\t\textraSkinWeights: object.hasExtraSkinWeights === true,'],
  ['if ( parameters.hasPositionAttribute )\n\t\t\t_programLayers.enable( 23 );',
    'if ( parameters.hasPositionAttribute )\n\t\t\t_programLayers.enable( 23 );\n\t\tif ( parameters.extraSkinWeights )\n\t\t\t_programLayers.enable( 24 );'],
  ['materialProperties.skinning = parameters.skinning;',
    'materialProperties.skinning = parameters.skinning;\n\t\t\tmaterialProperties.extraSkinWeights = parameters.extraSkinWeights;'],
  ['} else if ( ! object.isSkinnedMesh && materialProperties.skinning === true ) {',
    `} else if ( ! object.isSkinnedMesh && materialProperties.skinning === true ) {
					needsProgramChange = true;
				} else if ( ( object.hasExtraSkinWeights === true ) !== materialProperties.extraSkinWeights ) {`],
  extendShader('uniform highp sampler2D boneTexture;', `uniform highp sampler2D boneTexture;
	#ifdef VIEWER_EXTRA_SKIN_WEIGHTS
		attribute vec4 joints_1;
		attribute vec4 weights_1;
	#endif`),
  extendShader('mat4 boneMatW = getBoneMatrix( skinIndex.w );', `mat4 boneMatW = getBoneMatrix( skinIndex.w );
	#ifdef VIEWER_EXTRA_SKIN_WEIGHTS
		float viewerSkinWeightTotal = dot( skinWeight + weights_1, vec4( 1.0 ) );
		mat4 viewerExtraSkinMatrix = mat4( 0.0 );
		if ( weights_1.x > 0.0 ) viewerExtraSkinMatrix += weights_1.x * getBoneMatrix( joints_1.x );
		if ( weights_1.y > 0.0 ) viewerExtraSkinMatrix += weights_1.y * getBoneMatrix( joints_1.y );
		if ( weights_1.z > 0.0 ) viewerExtraSkinMatrix += weights_1.z * getBoneMatrix( joints_1.z );
		if ( weights_1.w > 0.0 ) viewerExtraSkinMatrix += weights_1.w * getBoneMatrix( joints_1.w );
	#endif`),
  extendShader('transformed = ( bindMatrixInverse * skinned ).xyz;', `#ifdef VIEWER_EXTRA_SKIN_WEIGHTS
		if ( viewerSkinWeightTotal > 0.0 ) {
			skinned = ( skinned + viewerExtraSkinMatrix * skinVertex ) / viewerSkinWeightTotal;
		} else {
			skinned = skinVertex;
		}
	#endif
	transformed = ( bindMatrixInverse * skinned ).xyz;`),
  extendShader('skinMatrix = bindMatrixInverse * skinMatrix * bindMatrix;', `#ifdef VIEWER_EXTRA_SKIN_WEIGHTS
		if ( viewerSkinWeightTotal > 0.0 ) {
			skinMatrix = ( skinMatrix + viewerExtraSkinMatrix ) / viewerSkinWeightTotal;
		} else {
			skinMatrix = mat4( 1.0 );
		}
	#endif
	skinMatrix = bindMatrixInverse * skinMatrix * bindMatrix;`),
]

export const extendedSkinningPatches = [['build/three.core.js', cpu], ['build/three.module.js', webgl]]
