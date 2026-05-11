const ANSI_ESCAPE_PATTERN = new RegExp(
  String.raw`[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))`,
  "g",
);

export function stripAnsi(value: string): string {
  return value.replaceAll(ANSI_ESCAPE_PATTERN, "");
}
