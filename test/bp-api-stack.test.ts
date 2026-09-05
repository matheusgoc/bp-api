import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { BpApiStack } from '../lib/bp-api-stack';

// Requires `npm run build` first (Code.fromAsset reads dist/) — handled by pretest
describe('BpApiStack', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new BpApiStack(app, 'TestStack');
    template = Template.fromStack(stack);
  });

  it('creates a DynamoDB table with PK/SK and GSI1', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({ IndexName: 'GSI1' }),
      ]),
    });
  });

  it('creates a Cognito user pool and client', () => {
    template.resourceCountIs('AWS::Cognito::UserPool', 1);
    template.resourceCountIs('AWS::Cognito::UserPoolClient', 1);
  });

  it('creates the seventeen Lambda handlers with tracing enabled', () => {
    const functions = template.findResources('AWS::Lambda::Function', {
      Properties: {
        Runtime: 'nodejs22.x',
        TracingConfig: { Mode: 'Active' },
      },
    });
    expect(Object.keys(functions)).toHaveLength(17);
  });

  it('creates a REST API with a Cognito authorizer', () => {
    template.resourceCountIs('AWS::ApiGateway::RestApi', 1);
    template.hasResourceProperties('AWS::ApiGateway::Authorizer', {
      Type: 'COGNITO_USER_POOLS',
    });
  });

  it('protects place and category mutations with Cognito auth but leaves list/preview public', () => {
    const protectedMethods = template.findResources('AWS::ApiGateway::Method', {
      Properties: { AuthorizationType: 'COGNITO_USER_POOLS' },
    });
    // POST /places, PUT /places/{id}, POST .../publish, POST .../unpublish, POST .../review,
    // POST .../images/{type}, POST .../images/{type}/approve, POST /categories,
    // PUT /categories/{id}, POST .../enable, POST .../disable, POST .../reorder
    expect(Object.keys(protectedMethods)).toHaveLength(12);

    const publicMethods = template.findResources('AWS::ApiGateway::Method', {
      Properties: { AuthorizationType: 'NONE' },
    });
    // GET /health, GET /places, GET /places/{id}, GET /categories, GET /categories/{id},
    // plus CORS OPTIONS preflight per resource
    expect(Object.keys(publicMethods).length).toBeGreaterThanOrEqual(5);
  });
});
