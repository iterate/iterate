/// <reference types="vite/client" />

// Declare module for image imports with ?url
declare module '*.jpg?url' {
  const src: string;
  export default src;
}

declare module '*.png?url' {
  const src: string;
  export default src;
}

declare module '*.svg?url' {
  const src: string;
  export default src;
}

declare module '*.jpeg?url' {
  const src: string;
  export default src;
}

declare module '*.gif?url' {
  const src: string;
  export default src;
}

declare module '*.webp?url' {
  const src: string;
  export default src;
}

declare module '*.ico?url' {
  const src: string;
  export default src;
}
