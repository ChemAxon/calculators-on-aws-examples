import { SQSEvent, SQSBatchResponse } from 'aws-lambda';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { BatchWriteItemCommand, DynamoDB, WriteRequest } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { CnsMpoResponse, CnsMpoResult, DbRecord, StructureRecord } from './types';
import axios, { AxiosResponse } from 'axios';
import axiosRetry from 'axios-retry';

const secretManager = new SecretsManagerClient();
let cxnApiKey : string | undefined;

const dynamodb = new DynamoDB();

axiosRetry(axios, {
    retries: 5,
    retryDelay: axiosRetry.exponentialDelay,
    retryCondition: (err) => {
        if (typeof err.response !== 'undefined') {
            return err.response.status === 429 || err.response.status === 504;
        }
        return false;
    },
    onRetry: (retryCount, error) => {
        console.warn('Retry failed request - status: ' + error.response?.status + ' [' + retryCount + ']');
    }
})

const createDbRecord = (structureRecord: StructureRecord, result: CnsMpoResult): DbRecord => {
    return {
        id: structureRecord.id,
        mol: structureRecord.mol,
        cns_mpo_score: result["cns-mpo"].score,
        cns_mpo_props: result["cns-mpo"].properties
    };
}

const getApiKeyFromSecretManager = async (): Promise<string> => {
    return secretManager
        .send(new GetSecretValueCommand({SecretId: process.env.API_KEY_SECRET_NAME}))
        .then((secret) => {
            if (typeof secret.SecretString === 'undefined') {
                throw new Error(`The API key secret is undefined, SecretId: ${process.env.API_KEY_SECRET_NAME}`)
            }
            return secret.SecretString;
        })
}

const calculateCnsMpoScore = async (structureRecords: StructureRecord[]): Promise<CnsMpoResponse> => {
    if (typeof cxnApiKey === 'undefined') {
        cxnApiKey = await getApiKeyFromSecretManager();
    }

    return axios.post<CnsMpoResponse, AxiosResponse<CnsMpoResponse>>(
        'https://api.calculators.cxn.io/rest-v1/calculator/batch/calculate',
        {
            calculations: { 'cns-mpo': {} },
            inputFormat: 'smiles',
            structures: structureRecords.map(r => r.mol)
        },
        {
            headers: { 'x-api-key': cxnApiKey },
        })
        .then(response => {
            return response.data;
        });
}

const store = async (records: DbRecord[]): Promise<void> => {
    const requests: WriteRequest[] = [];
    records.forEach(r => requests.push({PutRequest: {Item: marshall(r)}}));

    const tableName = process.env.DB_TABLE;
    return dynamodb.send(new BatchWriteItemCommand({
        RequestItems: {
            [tableName]: requests
        }
    })).then(out => {
        const status = out.$metadata.httpStatusCode;
        if (typeof status === 'number' && status < 200 && status > 299) {
            throw new Error("HTTP status - " + status + ': ' + JSON.stringify(out));
        }
    })
}

export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
    if (event.Records.length > 25) {
        throw new Error(`SQSEvent record count [ ${event.Records.length} ] > 25`);
    }

    const structureRecords : StructureRecord[] = event.Records.map((record) => JSON.parse(record.body));

    const dbRecords : DbRecord[] = [];
    const sqsBatchResponse : SQSBatchResponse = { batchItemFailures: [] }

    const cnsMpoResponse = await calculateCnsMpoScore(structureRecords);
    cnsMpoResponse.results.forEach((result, index) => {
        if (typeof result['cns-mpo'].error === 'undefined') {
            dbRecords.push(createDbRecord(structureRecords[index], result));
        } else {
            console.error(JSON.stringify({ input: structureRecords[index], error: result['cns-mpo'].error }));
            sqsBatchResponse.batchItemFailures.push({ itemIdentifier: event.Records[index].messageId });
        }
    });

    await store(dbRecords);
    console.log(`Processed records: ${structureRecords.length} | Failures: ${sqsBatchResponse.batchItemFailures.length}`);
    return sqsBatchResponse;
};
