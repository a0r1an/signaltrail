// Return decimal strings: Kafka offsets must never pass through Number.
export function measureSourceLag(highOffsets, committedOffsets) {
  if (
    !highOffsets.length ||
    new Set(highOffsets.map((entry) => entry.partition)).size !== highOffsets.length
  )
    throw new Error('Missing or duplicate source partitions');
  const partitions = highOffsets.map(({ partition, low = '0', offset }) => {
    const high = BigInt(offset);
    const first = BigInt(low);
    const committed = committedOffsets.find((entry) => entry.partition === partition)?.offset;
    const initialized = committed !== undefined && committed !== '-1';
    const next = initialized ? BigInt(committed) : first;
    if (first < 0n || high < first || next < 0n || next > high)
      throw new Error('Inconsistent source offsets');
    return {
      partition,
      high: high.toString(),
      committed: initialized ? committed : null,
      retentionGap: initialized && next < first,
      lag: (high - (next < first ? first : next)).toString(),
    };
  });
  return {
    total: partitions.reduce((total, entry) => total + BigInt(entry.lag), 0n).toString(),
    partitions,
  };
}
