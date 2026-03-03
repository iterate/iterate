declare global {
  type BodyInit = NonNullable<RequestInit["body"]>;
}

export {};
