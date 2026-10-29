// Producer and consumer use the same authenticated header projection.
export const signedHeaders = ['user-agent', 'accept', 'accept-language', 'sec-ch-ua-platform', 'origin', 'content-type', 'cookie'] as const;
// Missing and empty fields carry no usable evidence. Forward explicit empty values
// for missing fields so fetch cannot silently invent Accept/User-Agent metadata.
export function canonicalHeaders(read: (name: string) => string | null) { return JSON.stringify(signedHeaders.map(name => [name, read(name) || null])); }
