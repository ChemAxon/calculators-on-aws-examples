#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ChemaxonCalculatorsExampleStack } from './stack';

const app = new cdk.App();
new ChemaxonCalculatorsExampleStack(app, 'ChemaxonCalculatorsExampleStack', {
    env: {
        account: process.env.CDK_DEFAULT_ACCOUNT,
        region: process.env.CDK_DEFAULT_REGION
    },
});
