# Calculators on AWS Marketplace - Workflow example

This repository is a **proof of concept** demonstrating how a simple workflow can be built using [Calculators on AWS Marketplace](https://docs.chemaxon.com/display/lts-lithium/calculators-aws-marketplace.md). The workflow contains the following steps:
- parsing molecular structures from an S3 bucket and sending them to an SQS
- calculating [CNS-MPO scores](https://docs.chemaxon.com/display/docs/cns-mpo-score.md) with Calculators on AWS Marketplace
- storing the calculated results in a DynamoDB table
- filtering molecules based on their CNS-MPO scores (test)

If you have any questions or suggestions,  please feel free to contact us at
[`calculators-support@chemaxon.com`](mailto:calculators-support@chemaxon.com)

## Architecture diagram
<img src="architecture-diagram.png" alt="Architecture diagram" />

## Prerequisites

- Create an [AWS account](https://aws.amazon.com/) if you do not have one yet.
- Subscribe to the [Calculators on AWS Marketplace](https://aws.amazon.com/marketplace/pp/prodview-bpnrwlvx2cys4) service and store your API key. [Step-by-step guide](https://docs.chemaxon.com/display/lts-lithium/calculators-aws-marketplace-getting-started.md).
- Install [AWS CLI](https://aws.amazon.com/cli/). The `aws configure` command is the fastest way to set up your AWS CLI installation. See this [quickstart guide](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-quickstart.html#cli-configure-quickstart-config).
- Install [NodeJS](https://nodejs.org/en/download/package-manager/).

## AWS resources

The project uses only some basic AWS resources (**S3**, **SQS**, **Lambda** and **DynamoDB**). If you want to know more about them,  please visit the related [AWS documentation](https://docs.aws.amazon.com/) pages.

### Role
The appropriate role has to be configured to access the created AWS resources.
````
aws iam create-role --role-name cxn-lambda-role --assume-role-policy-document file://config/role-trust-policy.json
aws iam attach-role-policy --role-name test-aws-cli-role --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
aws iam attach-role-policy --role-name test-aws-cli-role --policy-arn arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess
aws iam attach-role-policy --role-name test-aws-cli-role --policy-arn arn:aws:iam::aws:policy/AmazonSQSFullAccess
aws iam attach-role-policy --role-name test-aws-cli-role --policy-arn arn:aws:iam::aws:policy/AmazonDynamoDBFullAccess
````

### S3
````
aws s3api create-bucket --bucket <BUCKET_NAME> --create-bucket-configuration LocationConstraint=<AWS_REGION>
````

### DynamoDB
````
aws dynamodb create-table --cli-input-json file://config/dynamodb.json
````

### SQS
````
aws sqs create-queue --queue-name CxnMoleculeRecords.fifo --attributes FifoQueue=true
````

### Lambda functions
You can build and deploy Lambda functions with the following commands (replace the `<AWS_ACCOUNT_ID>` to your AWS account number):
````
npm install
npm run build
aws lambda create-function \
    --function-name cxn-csv-parser \
    --runtime "nodejs16.x" \
    --role arn:aws:iam::<AWS_ACCOUNT_ID>:role/cxn-lambda-role \
    --zip-file "fileb://dist/csv-parser.zip" \
    --handler index.handler \
    --memory-size 512 \
    --timeout 900 \
    --environment Variables={BUCKET=<BUCKET_NAME>,FILE_NAME=molecules.smiles} \
aws lambda create-function \
    --function-name cxn-cns-mpo \
    --runtime "nodejs16.x" \
    --role arn:aws:iam::<AWS_ACCOUNT_ID>:role/cxn-lambda-role \
    --zip-file "fileb://dist/cns-mpo.zip" \
    --handler index.handler \
    --timeout 300 \
    --environment Variables={API_KEY=<YOUR_API_KEY>} \
````

### Lambda functions - update
If a Lambda function is created and you want to update it, you can use the following commands:
````
npm run build
aws lambda update-function-code --function-name cxn-csv-parser --zip-file "fileb://dist/csv-parser.zip"
aws lambda update-function-code --function-name cxn-cns-mpo --zip-file "fileb://dist/cns-mpo.zip"
````

## Download molecules and upload to the S3 bucket
**!! Please be careful and do not upload more than 100 structures for testing purposes to prevent an unexpected cost. !!**

The following commands download molecular structures in SMILES format and upload the first **100 structures** to the created S3 bucket:
````
wget https://mcule.s3.amazonaws.com/database/mcule_ultimate_express1_220828.smi.gz
gzcat mcule_ultimate_express1_220828.smi.gz | head -n 100 >molecules.smiles
aws s3 cp molecules.smiles s3://<BUCKET_NAME>/
````

## Cost of calculations
- Subscribing to the service is **free of charge**. The cost is based on the number of calculation units consumed. Please check the [Pricing](https://docs.chemaxon.com/display/lts-lithium/calculators-aws-marketplace-pricing.md) page for further details.
- The price of the CNS-MPO calculation is **7 units/structure** so the below test run on 100 structures costs **7 USD**.
- There is some minimal cost of using the AWS resources ([AWS Pricing documentation](https://aws.amazon.com/pricing/)). **We recommend to delete the created resources after the test run finished.**

## Test
The Lambda function can be invoked to parse CSV records and send them to the SQS:
````
aws lambda invoke \
    --function-name cxn-csv-parser \
    --cli-binary-format raw-in-base64-out \
    --payload '{ "chunkSize": 100, "groupCount": 1, "limit": 100 }' \
    csv-parser-response.json
````

The records from SQS are processed automatically and molecules can be searched based on the CNS MPO score:
````
aws dynamodb query \
    --table-name CxnCnsMpoResults \
    --index-name cns_mpo_score_index \
    --key-condition-expression "cns_mpo_score = :s" \
    --expression-attribute-values '{ ":s": {"N": "5.0"} }' \
````
