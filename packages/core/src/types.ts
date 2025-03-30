export type Optional<T> = T | undefined;
export type TransformerFunction = Optional<(data: Buffer, mapping: string) => Buffer>;
