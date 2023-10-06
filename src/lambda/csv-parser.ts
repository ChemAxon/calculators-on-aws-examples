import { SendMessageBatchCommand, SendMessageBatchRequestEntry, SQSClient } from '@aws-sdk/client-sqs';
import { S3Client, ScanRange, SelectObjectContentCommand } from '@aws-sdk/client-s3';
import { RawCsvRecord, StructureRecord } from './types';
import { chunk } from 'lodash';
import { S3Event } from 'aws-lambda';

const JSON_RECORD_DELIMITER = '|';
const S3_CHUNK_SIZE = 100000;
const SQS_MAX_BATCH_SIZE = 10;

const s3 = new S3Client();
const sqs = new SQSClient();

const parseRecordsFromCsv = async (bucket: string, file: string, range: ScanRange): Promise<StructureRecord[]> => {
    const result = await s3.send(new SelectObjectContentCommand({
        Bucket: bucket,
        Key: file,
        Expression: 'SELECT * FROM S3Object',
        ExpressionType: 'SQL',
        InputSerialization: { CSV: { FileHeaderInfo: 'NONE', FieldDelimiter: '\t', RecordDelimiter: '\n' } },
        OutputSerialization: { JSON: { RecordDelimiter: JSON_RECORD_DELIMITER } },
        ScanRange: range
    }))

    if (typeof result.Payload === 'undefined') {
        throw new Error('The result.Payload is undefined');
    }

    const textDecoder = new TextDecoder();
    var out = '';

    for await (const eventStream of result.Payload) {
        if (typeof eventStream.Records !== 'undefined') {
            out = out.concat(textDecoder.decode(eventStream.Records?.Payload as ArrayBuffer));
        }
    }

    return out
        .split(JSON_RECORD_DELIMITER)
        .filter(r => r !== '')
        .map(r => JSON.parse(r) as RawCsvRecord)
        .map(r => ({ id: r._2, mol: r._1 }));
}

const sendRecordsToQueue = async (records: StructureRecord[]): Promise<void> => {
    const entries: SendMessageBatchRequestEntry[] = records.map((record) => ({
        Id: record.id,
        MessageBody: JSON.stringify(record),
    }));

    return sqs.send(new SendMessageBatchCommand({
        QueueUrl: process.env.SQS_QUEUE_URL,
        Entries: entries
    }))
        .then((response) => {
            if (typeof response.Failed !== 'undefined') {
                console.error(JSON.stringify(response.Failed));
            }
        })

}

export const handler = async (event: S3Event): Promise<void> => {
    for (const record of event.Records) {
        console.log(`File: s3://${record.s3.bucket.name}/${record.s3.object.key}`);

        const fileSize = typeof process.env.S3_SIZE_LIMIT !== 'undefined'
            ? Math.min(record.s3.object.size, parseInt(process.env.S3_SIZE_LIMIT))
            : record.s3.object.size;
        console.log(`Size: ${record.s3.object.size} (Limit: ${fileSize})`);

        let numberOfParsedRecords = 0;

        for (let i = 0; i < fileSize; i += S3_CHUNK_SIZE) {
            const range: ScanRange = { Start: i, End: Math.min(i + S3_CHUNK_SIZE - 1, fileSize) };

            const records: StructureRecord[] = await parseRecordsFromCsv(record.s3.bucket.name, record.s3.object.key, range);
            numberOfParsedRecords += records.length;
            console.log(`Parsed records: ${records.length} | TOTAL: ${numberOfParsedRecords}`);

            const batches = chunk(records, SQS_MAX_BATCH_SIZE);
            const response = batches.map((batch) => sendRecordsToQueue(batch));
            await Promise.all(response);
        }
    }
};
