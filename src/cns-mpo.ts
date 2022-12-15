import { Context, SQSEvent } from 'aws-lambda';
import { BatchWriteItemCommand, DynamoDB, WriteRequest } from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import { DbRecord, StructureRecord } from './types';
import axios from 'axios';
import axiosRetry from 'axios-retry';

const dynamodb = new DynamoDB({});

axiosRetry(axios, {
    retries: 5,
    retryDelay: axiosRetry.exponentialDelay,
    retryCondition: (err) => {
        if (typeof err.response !== 'undefined') {
            return err.response.status === 429 || err.response.status === 504;
        }
        return false;
    },
    onRetry: (retryCount, error, requestConfig) => {
        console.warn('Retry failed request - status: ' + error.response?.status + ' [' + retryCount + ']');
    }
})

const createDbRecord = (structureRecord: StructureRecord, response: any) => {
    const dbRecord = {
        id: structureRecord.id,
        mol: structureRecord.mol,
        cns_mpo_score: response['cns-mpo'].score,
        cns_mpo_props: {}
    }
    response['cns-mpo'].properties.forEach(p => dbRecord.cns_mpo_props[p.name] = {value: p.value, score: p.score});
    return dbRecord;
}

const calculateCnsMpoScore = async (structureRecords: StructureRecord[]): Promise<DbRecord[]> => {

    return axios.post('https://api.calculators.cxn.io/rest-v1/calculator/batch/calculate', {
        calculations: { 'cns-mpo': {} },
        inputFormat: 'smiles',
        structures: structureRecords.map(r => r.mol)
    },
        {
            headers: {
                'x-api-key': process.env.API_KEY as string
            }
        }).then(response => {
            const results = response.data.results;
            return results.map(r => createDbRecord(structureRecords[results.indexOf(r)], r));
        }).catch(err => {
            throw new Error('Failed request - ' + JSON.stringify(err) + ' - ' + JSON.stringify(structureRecords));
        });
}

const store = async (records: DbRecord[]): Promise<void> => {
    const requests: WriteRequest[] = [];
    records.forEach(r => requests.push({ PutRequest: { Item: marshall(r) } }));

    return dynamodb.send(new BatchWriteItemCommand({
        RequestItems: {
            CxnCnsMpoResults: requests
        }
    })).then(out => {
        const status = out.$metadata.httpStatusCode;
        if (typeof status === 'number' && status < 200 && status > 299) {
            throw new Error("HTTP status - " + status + ': ' + JSON.stringify(out));
        }
    })
}


export const handler = async (event: SQSEvent, context: Context): Promise<void> => {

    if (event.Records.length !== 1) {
        console.error(`SQSEvent record count [ ${event.Records.length} ] != 1`);
        return;
    }

    const records: StructureRecord[] = JSON.parse(event.Records[0].body);

    if (records.length > 25) {
        console.error(`StructureRecord[] length [ ${records.length} ] > 25`);
        return;
    }

    await calculateCnsMpoScore(records)
        .then(dbRecords => store(dbRecords))
        .catch(err => console.error(err));
 };
