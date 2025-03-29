export type Optional<T> = T | undefined;
export type TransformFunction = Optional<(data: Buffer, mapping: string) => Buffer>;
