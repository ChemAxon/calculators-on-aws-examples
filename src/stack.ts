import { CfnParameter, Duration, RemovalPolicy, SecretValue, Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { Bucket, EventType } from 'aws-cdk-lib/aws-s3';
import { AttributeType, Table } from 'aws-cdk-lib/aws-dynamodb';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import { S3EventSource, SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';

export class ChemaxonCalculatorsExampleStack extends Stack {
    constructor(scope: Construct, id: string, props?: StackProps) {
        super(scope, id, props);

        const bucketName = new CfnParameter(this, 'bucketName', {
            type: 'String',
            description: 'The S3 bucket name.',
        });

        const cxnApiKey = new CfnParameter(this,  'cxnApiKey', {
            type: 'String',
            noEcho: true,
            description: 'The API key for api.calculators.cxn.io calls.',
            minLength: 40,
            maxLength: 40,
        });

        const secret = new Secret(this, 'cxn-secret-api-key', {
            secretName: 'cxn-example/api-key',
            description: 'The API key for api.calculators.cxn.io calls.',
            secretStringValue: SecretValue.unsafePlainText(cxnApiKey.valueAsString),
        });

        const bucket = new Bucket(this, 'cxn-bucket', {
            bucketName: bucketName.valueAsString,
            removalPolicy: RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
        });

        const table = new Table(this, 'cxn-dynamodb-table', {
            tableName: 'CxnResults',
            partitionKey: { name: 'id', type: AttributeType.STRING },
            removalPolicy: RemovalPolicy.DESTROY,
        });

        const queue = new Queue(this, 'cxn-queue', {
            queueName: 'CxnQueue.fifo',
            fifo: true,
            contentBasedDeduplication: true,
            visibilityTimeout: Duration.minutes(5),
        });

        const csvParser = new NodejsFunction(this, 'cxn-lambda-csv-parser', {
            functionName: 'cxn-csv-parser',
            entry: 'src/lambda/csv-parser.ts',
            runtime: Runtime.NODEJS_18_X,
            environment: {
                S3_CHUNK_SIZE: '1000',
                S3_SIZE_LIMIT: '10000',
                SQS_QUEUE_URL: queue.queueUrl,
                SQS_GROUP_COUNT: '1',
            },
            memorySize: 512,
            timeout: Duration.minutes(15),
        });
        csvParser.addEventSource(new S3EventSource(bucket, { events: [EventType.OBJECT_CREATED] }));
        bucket.grantRead(csvParser);
        queue.grantSendMessages(csvParser);

        const cnsMpoCalculator = new NodejsFunction(this, 'cxn-lambda-cns-mpo', {
            functionName: 'cxn-cns-mpo',
            entry: 'src/lambda/cns-mpo.ts',
            runtime: Runtime.NODEJS_18_X,
            environment: {
                API_KEY_SECRET_NAME: secret.secretName,
                DB_TABLE: table.tableName,
            },
            timeout: Duration.minutes(5),
        });
        cnsMpoCalculator.addEventSource(new SqsEventSource(queue, { batchSize: 1 }));
        secret.grantRead(cnsMpoCalculator);
        table.grantWriteData(cnsMpoCalculator);
    }
}
