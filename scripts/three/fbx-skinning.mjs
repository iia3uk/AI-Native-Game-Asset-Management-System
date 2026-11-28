// Store the second FBX weight set in the same attributes as the glTF loader.
const originalTriangleWeights = ['i0', 'i1', 'i2'].map(vertex =>
  [0, 1, 2, 3].map(slot => `\t\t\t\tbuffers.vertexWeights.push( faceWeights[ ${vertex} * 4${slot ? ' + ' + slot : ''} ] );`).join('\n')
).join('\n\n')
const originalTriangleIndices = originalTriangleWeights
  .replaceAll('vertexWeights', 'weightsIndices').replaceAll('faceWeights', 'faceWeightIndices')

export const fbxSkinningPatches = [
  ['geoInfo.weightTable = {};', 'geoInfo.weightTable = {};\n\t\tgeoInfo.skinWeightSlots = 4;'],
  ['if ( geoInfo.weightTable[ index ] === undefined ) geoInfo.weightTable[ index ] = [];', `if ( rawBone.weights[ j ] === 0 ) return;
					if ( geoInfo.weightTable[ index ] === undefined ) geoInfo.weightTable[ index ] = [];
					if ( geoInfo.weightTable[ index ].length === 4 ) geoInfo.skinWeightSlots = 8;`],
  ['vertexWeights: [],\n\t\t\tweightsIndices: [],', `vertexWeights: [],
			weightsIndices: [],
			extraWeights: [],
			extraIndices: [],`],
  ['if ( weights.length > 4 ) {', 'if ( weights.length > geoInfo.skinWeightSlots ) {'],
  ['Vertex has more than 4 skinning weights assigned to vertex. Deleting additional weights.',
    'Vertex has more than 8 skinning weights. Using the eight largest weights.'],
  ['const wIndex = [ 0, 0, 0, 0 ];\n\t\t\t\t\tconst Weight = [ 0, 0, 0, 0 ];',
    'const wIndex = new Array( geoInfo.skinWeightSlots ).fill( 0 );\n\t\t\t\t\tconst Weight = new Array( geoInfo.skinWeightSlots ).fill( 0 );'],
  ['// if the weight array is shorter than 4 pad with 0s\n\t\t\t\twhile ( weights.length < 4 ) {',
    '// Pad short weight arrays to the number of slots per vertex.\n\t\t\t\twhile ( weights.length < geoInfo.skinWeightSlots ) {'],
  ['for ( let i = 0; i < 4; ++ i ) {\n\n\t\t\t\t\tfaceWeights.push( weights[ i ] );',
    'for ( let i = 0; i < geoInfo.skinWeightSlots; ++ i ) {\n\n\t\t\t\t\tfaceWeights.push( weights[ i ] );'],
  [originalTriangleWeights + '\n\n' + originalTriangleIndices, `				for ( const faceVertex of [ i0, i1, i2 ] ) {

					const start = faceVertex * geoInfo.skinWeightSlots;
					for ( let slot = 0; slot < 4; slot ++ ) {

						buffers.vertexWeights.push( faceWeights[ start + slot ] );
						buffers.weightsIndices.push( faceWeightIndices[ start + slot ] );

					}
					for ( let slot = 4; slot < geoInfo.skinWeightSlots; slot ++ ) {

						buffers.extraWeights.push( faceWeights[ start + slot ] );
						buffers.extraIndices.push( faceWeightIndices[ start + slot ] );

					}

				}`],
  ["geo.setAttribute( 'skinWeight', new Float32BufferAttribute( buffers.vertexWeights, 4 ) );",
    `geo.setAttribute( 'skinWeight', new Float32BufferAttribute( buffers.vertexWeights, 4 ) );
			if ( buffers.extraWeights.length > 0 ) {

				geo.setAttribute( 'joints_1', new Uint16BufferAttribute( buffers.extraIndices, 4 ) );
				geo.setAttribute( 'weights_1', new Float32BufferAttribute( buffers.extraWeights, 4 ) );

			}`],
]
