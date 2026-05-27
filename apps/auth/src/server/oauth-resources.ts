export function getOsResourceBases() {
  return [
    "https://os.iterate.com",
    "https://os.iterate-dev-jonas.com",
    "https://os.iterate-dev-misha.com",
    "https://os.iterate-dev-rahul.com",
    ...[2, 3, 4, 5, 6, 7, 8, 9].map(
      (previewNumber) => `https://os.iterate-preview-${previewNumber}.com`,
    ),
  ];
}
