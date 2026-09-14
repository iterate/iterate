// Vite's `?raw` import (the workers lane runs under Vite, and workerd has no fs): the file's text.
declare module "*.sql?raw" {
  const text: string;
  export default text;
}
