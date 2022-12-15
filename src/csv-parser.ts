import { SendMessageBatchCommand, SendMessageBatchRequestEntry, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { Context, SQSEvent } from 'aws-lambda';
import { S3Client, ScanRange, HeadObjectCommand, SelectObjectContentCommand } from '@aws-sdk/client-s3';
import { RawCsvRecord, StructureRecord } from './types';
import chunk from "lodash.chunk";

const JSON_RECORD_DELIMITER = '|';
const DEFAULT_CHUNK_SIZE = 1000;
const DEFAULT_GROUP_COUNT = 1;

const sqs = new SQSClient({});

const bucket = process.env.BUCKET as string;
const fileName = process.env.FILE_NAME as string;

const parseRecordsFromCsv = async (bucket: string, file: string, range: ScanRange): Promise<StructureRecord[]> => {
    const s3 = new S3Client({});
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
            out = out.concat(textDecoder.decode(eventStream.Records?.Payload));
        }
    }

    const records: StructureRecord[] = out
        .split(JSON_RECORD_DELIMITER)
        .filter(r => r !== '')
        .map(r => JSON.parse(r) as RawCsvRecord)
        .map(r => ({ id: r._2, mol: r._1 }));
    return records;
}

const sendRecordsToQueue = async (records: StructureRecord[][], groupId: number) => {
    const entries: SendMessageBatchRequestEntry[] = records.map(r => ({
        Id: records.indexOf(r).toString(),
        MessageBody: JSON.stringify(r),
        MessageGroupId: groupId.toString()
    }));

    const response = await sqs.send(new SendMessageBatchCommand({
        QueueUrl: 'https://sqs.eu-west-1.amazonaws.com/104204224647/CxnMoleculeRecords.fifo',
        Entries: entries
    }));

    if (typeof response.Failed !== 'undefined') {
        console.error(JSON.stringify(response.Failed));
    }
}

export const handler = async (event: { chunkSize?: number, groupCount?: number, limit?: number }, context: Context): Promise<void> => {
    console.log(`Event: ${JSON.stringify(event, null, 2)}`);

    const chunkSize = typeof event.chunkSize === 'undefined' ? DEFAULT_CHUNK_SIZE : event.chunkSize;
    const groupCount = typeof event.groupCount === 'undefined' ? DEFAULT_GROUP_COUNT : event.groupCount;

    const s3 = new S3Client({});
    const out = await s3.send(new HeadObjectCommand({
        Bucket: bucket,
        Key: fileName
    }))

    if (typeof out.ContentLength === 'undefined') {
        throw new Error('The ContentLength is undefined.');
    }

    const fileSize = typeof event.limit !== 'undefined' ? Math.min(out.ContentLength, event.limit) : out.ContentLength;
    console.log('Size: ' + fileSize);

    let numberOfParsedRecords = 0;

    for (let i = 0; i < fileSize; i += chunkSize) {
        const range: ScanRange = { Start: i, End: Math.min(i + chunkSize - 1, fileSize) };

        const records: StructureRecord[] = await parseRecordsFromCsv(bucket, fileName, range);
        numberOfParsedRecords += records.length;
        console.log('Parsed records: ' + records.length + ' / ' + numberOfParsedRecords);

        const chunks = chunk(chunk(records, 25), 10);

        let groupId = 0;
        for (const c of chunks) {
            await sendRecordsToQueue(c, groupId);
            groupId = groupId + 1 < groupCount ? groupId + 1 : 0
        }

    }


};
