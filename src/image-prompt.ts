export function buildImagePrompt(userPrompt: string, hasParent: boolean, materialLabels: string[]) {
  if (!hasParent && materialLabels.length === 0) return userPrompt;
  const mapping: string[] = [];
  let inputPosition = 1;
  if (hasParent) {
    mapping.push(`- Base checkpoint: input image ${inputPosition}. This is the image being edited or continued.`);
    inputPosition++;
  }
  materialLabels.forEach((label, index) => {
    mapping.push(`- Material ${index + 1}: input image ${inputPosition} (${label}).`);
    inputPosition++;
  });
  return [
    'REFERENCE MAP',
    'The attached images are ordered exactly as listed below. Material numbers refer to the user-visible selection numbers; do not count the base checkpoint as a material.',
    ...mapping,
    '',
    'USER INSTRUCTIONS',
    userPrompt,
  ].join('\n');
}
