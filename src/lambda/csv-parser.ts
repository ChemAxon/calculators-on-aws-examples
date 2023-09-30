import { SendMessageBatchCommand, SendMessageBatchRequestEntry, SQSClient } from '@aws-sdk/client-sqs';
import { S3Client, ScanRange, SelectObjectContentCommand } from '@aws-sdk/client-s3';
import { RawCsvRecord, StructureRecord } from './types';
import { chunk } from 'lodash';
import { S3Event } from 'aws-lambda';

const JSON_RECORD_DELIMITER = '|';
const DEFAULT_CHUNK_SIZE = 1000;
const DEFAULT_GROUP_COUNT = 1;
const MAX_BATCH_SIZE_CXN_API = 25;
const MAX_BATCH_SIZE_SQS_FIFO = 10;

const s3 = new S3Client();
const sqs = new SQSClient();

const chunkSize = typeof process.env.S3_CHUNK_SIZE !== 'undefined' ? parseInt(process.env.S3_CHUNK_SIZE) : DEFAULT_CHUNK_SIZE;
const groupCount = typeof process.env.SQS_GROUP_COUNT !== 'undefined' ? parseInt(process.env.SQS_GROUP_COUNT) : DEFAULT_GROUP_COUNT;

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

const sendRecordsToQueue = async (records: StructureRecord[][], groupId: number) => {
    const entries: SendMessageBatchRequestEntry[] = records.map(r => ({
        Id: records.indexOf(r).toString(),
        MessageBody: JSON.stringify(r),
        MessageGroupId: groupId.toString()
    }));

    const response = await sqs.send(new SendMessageBatchCommand({
        QueueUrl: process.env.SQS_QUEUE_URL,
        Entries: entries
    }));

    if (typeof response.Failed !== 'undefined') {
        console.error(JSON.stringify(response.Failed));
    }
}

export const handler = async (event: S3Event): Promise<void> => {
    for (const record of event.Records) {
        console.log(`File: s3://${record.s3.bucket.name}/${record.s3.object.key}`);

        const fileSize = typeof process.env.S3_SIZE_LIMIT !== 'undefined'
            ? Math.min(record.s3.object.size, parseInt(process.env.S3_SIZE_LIMIT))
            : record.s3.object.size;
        console.log(`Size: ${record.s3.object.size} (Limit: ${fileSize})`);

        let numberOfParsedRecords = 0;

        for (let i = 0; i < fileSize; i += chunkSize) {
            const range: ScanRange = { Start: i, End: Math.min(i + chunkSize - 1, fileSize) };

            const records: StructureRecord[] = await parseRecordsFromCsv(record.s3.bucket.name, record.s3.object.key, range);
            numberOfParsedRecords += records.length;
            console.log(`Parsed records: ${records.length} | TOTAL: ${numberOfParsedRecords}`);

            const chunks = chunk(chunk(records, MAX_BATCH_SIZE_CXN_API), MAX_BATCH_SIZE_SQS_FIFO);

            let groupId = 0;
            for (const chunk of chunks) {
                await sendRecordsToQueue(chunk, groupId);
                groupId = groupId + 1 < groupCount ? groupId + 1 : 0
            }
        }
    }


};
