/**
 * Collect a Cursor test stream on the repository's ES2024 compiler target.
 * @param stream - Stream to consume completely.
 * @returns All emitted chunks in order.
 */
export async function collectStream<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const chunks: T[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}
