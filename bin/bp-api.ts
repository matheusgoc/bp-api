#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { BpApiStack } from '../lib/bp-api-stack';

const app = new cdk.App();

new BpApiStack(app, 'BpApiStack', {
  description: 'Bairro Promo serverless API (Lambda + API Gateway + DynamoDB + Cognito)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  tags: {
    project: 'bairro-promo',
    service: 'bp-api',
  },
});
