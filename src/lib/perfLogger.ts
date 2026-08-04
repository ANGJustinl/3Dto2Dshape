type PerfSample = {
    label: string;
    values: Record<string, number>;
};

type PerfBucket = {
    count: number;
    sums: Record<string, number>;
    last: Record<string, number>;
};

const buckets = new Map<string, PerfBucket>();
const LOG_INTERVAL = 20;

const round = (value: number) => Math.round(value * 100) / 100;

export const recordPerfSample = ({ label, values }: PerfSample) => {
    const bucket = buckets.get(label) ?? {
        count: 0,
        sums: {},
        last: {},
    };

    bucket.count += 1;
    bucket.last = values;

    Object.entries(values).forEach(([key, value]) => {
        bucket.sums[key] = (bucket.sums[key] ?? 0) + value;
    });

    buckets.set(label, bucket);

    if (bucket.count % LOG_INTERVAL !== 0) {
        return;
    }

    const average: Record<string, number> = {};
    Object.entries(bucket.sums).forEach(([key, value]) => {
        average[key] = round(value / bucket.count);
    });

    const last: Record<string, number> = {};
    Object.entries(bucket.last).forEach(([key, value]) => {
        last[key] = round(value);
    });

    console.log(
        `[perf:${label}]`,
        JSON.stringify({
            samples: bucket.count,
            averageMs: average,
            lastMs: last,
        }),
    );
};
