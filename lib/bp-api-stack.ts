import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';

const SERVICE_NAME = 'bp-api';

export class BpApiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ─────────────────────────────────────────────
    // DynamoDB — single-table design
    // PK/SK for entity access patterns, GSI1 for listings
    // ─────────────────────────────────────────────

    const table = new dynamodb.Table(this, 'Table', {
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      // DESTROY is convenient while iterating; switch to RETAIN before prod
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    table.addGlobalSecondaryIndex({
      indexName: 'GSI1',
      partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI1SK', type: dynamodb.AttributeType.STRING },
    });

    // Always-present partition key (GSI2PK='PLACE' on every place item) — powers
    // the admin "unpublished"/"all" listing, which has no visibility gate.
    table.addGlobalSecondaryIndex({
      indexName: 'GSI2',
      partitionKey: { name: 'GSI2PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI2SK', type: dynamodb.AttributeType.STRING },
    });

    // ─────────────────────────────────────────────
    // S3 — place photo/logo storage
    // ─────────────────────────────────────────────

    const imagesBucket = new s3.Bucket(this, 'ImagesBucket', {
      // DESTROY is convenient while iterating; switch to RETAIN before prod
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ACLS_ONLY,
      cors: [
        {
          allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.GET],
          allowedOrigins: ['*'],
          allowedHeaders: ['*'],
          exposedHeaders: ['ETag'],
          maxAge: 3000,
        },
      ],
    });

    imagesBucket.grantPublicAccess('places/*/photo.*', 's3:GetObject');
    imagesBucket.grantPublicAccess('places/*/logo.*', 's3:GetObject');

    // ─────────────────────────────────────────────
    // Cognito — user pool for the mobile app
    // ─────────────────────────────────────────────

    const userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: 'bairro-promo-users',
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: {
        fullname: { required: true, mutable: true },
      },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireDigits: false,
        requireSymbols: false,
        requireUppercase: false,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const userPoolClient = userPool.addClient('MobileClient', {
      userPoolClientName: 'bairro-promo-mobile',
      authFlows: { userPassword: true, userSrp: true },
      preventUserExistenceErrors: true,
      accessTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(30),
    });

    // ─────────────────────────────────────────────
    // Lambda factory — shared defaults (Powertools, X-Ray, logs)
    // Code comes from dist/<name>, produced by scripts/build.mjs
    // ─────────────────────────────────────────────

    const makeFunction = (name: string): lambda.Function => {
      const logGroup = new logs.LogGroup(this, `${name}Logs`, {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });

      return new lambda.Function(this, `${name}Fn`, {
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        code: lambda.Code.fromAsset(path.join(__dirname, '..', 'dist', name)),
        handler: 'index.handler',
        memorySize: 256,
        timeout: cdk.Duration.seconds(10),
        tracing: lambda.Tracing.ACTIVE,
        logGroup,
        environment: {
          TABLE_NAME: table.tableName,
          DYNAMODB_ENDPOINT: '', // empty by default; overridden by env.json when running under SAM local
          POWERTOOLS_SERVICE_NAME: SERVICE_NAME,
          POWERTOOLS_METRICS_NAMESPACE: 'BairroPromo',
          POWERTOOLS_LOG_LEVEL: 'INFO',
          POWERTOOLS_TRACE_ENABLED: 'true',
        },
      });
    };

    // health

    const healthFn = makeFunction('health');

    // category
    
    const addCategoryFn = makeFunction('categories-add');
    const updateCategoryFn = makeFunction('categories-update');
    const listCategoriesFn = makeFunction('categories-list');
    const previewCategoryFn = makeFunction('categories-preview');
    const enableCategoryFn = makeFunction('categories-enable');
    const disableCategoryFn = makeFunction('categories-disable');
    const reorderCategoriesFn = makeFunction('categories-reorder');
    table.grantWriteData(addCategoryFn);
    table.grantWriteData(updateCategoryFn);
    table.grantWriteData(enableCategoryFn);
    table.grantWriteData(disableCategoryFn);
    table.grantWriteData(reorderCategoriesFn);
    table.grantReadData(listCategoriesFn);
    table.grantReadData(previewCategoryFn);

    // place
    
    const addPlaceFn = makeFunction('places-add');
    const updatePlaceFn = makeFunction('places-update');
    const publishPlaceFn = makeFunction('places-publish');
    const unpublishPlaceFn = makeFunction('places-unpublish');
    const reviewPlaceFn = makeFunction('places-review');
    const previewPlaceFn = makeFunction('places-preview');

    const listPlacesFn = makeFunction('places-list');
    listPlacesFn.addEnvironment('USER_POOL_ID', userPool.userPoolId);
    listPlacesFn.addEnvironment('USER_POOL_CLIENT_ID', userPoolClient.userPoolClientId);

    const uploadPlaceImageFn = makeFunction('places-upload-image');
    const approvePlaceImageFn = makeFunction('places-approve-image');
    for (const fn of [uploadPlaceImageFn, approvePlaceImageFn]) {
      fn.addEnvironment('BUCKET_NAME', imagesBucket.bucketName);
      fn.addEnvironment('S3_ENDPOINT', '');
      fn.addEnvironment('S3_PRESIGN_ENDPOINT', '');
      fn.addEnvironment('S3_PUBLIC_URL_BASE', `https://${imagesBucket.bucketRegionalDomainName}`);
    }

    table.grantWriteData(addPlaceFn);
    table.grantWriteData(updatePlaceFn);
    table.grantWriteData(publishPlaceFn);
    table.grantWriteData(unpublishPlaceFn);
    table.grantWriteData(reviewPlaceFn);
    table.grantReadData(listPlacesFn);
    table.grantReadData(previewPlaceFn);

    table.grantWriteData(uploadPlaceImageFn);
    imagesBucket.grantPut(uploadPlaceImageFn); // s3:PutObject only — presigning needs no other S3 permission
    table.grantReadWriteData(approvePlaceImageFn);
    imagesBucket.grantRead(approvePlaceImageFn);
    imagesBucket.grantPut(approvePlaceImageFn);
    imagesBucket.grantDelete(approvePlaceImageFn);

    // location

    const addLocationFn = makeFunction('locations-add');
    const updateLocationFn = makeFunction('locations-update');
    const removeLocationFn = makeFunction('locations-remove');
    const previewLocationFn = makeFunction('locations-preview');

    // add/update/remove read the caller's profile (role check) and transact-write
    // the location + the parent place's review reset
    table.grantReadWriteData(addLocationFn);
    table.grantReadWriteData(updateLocationFn);
    table.grantReadWriteData(removeLocationFn);
    table.grantReadData(previewLocationFn);

    // profile

    const signupProfileFn = makeFunction('profile-signup');

    const previewProfileFn = makeFunction('profile-preview');
    const updateProfileFn = makeFunction('profile-update');
    const convertProfileFn = makeFunction('profile-convert');

    table.grantReadWriteData(signupProfileFn);
    table.grantReadData(previewProfileFn);
    table.grantReadWriteData(updateProfileFn);
    table.grantReadWriteData(convertProfileFn);

    // ─────────────────────────────────────────────
    // API Gateway (REST) + Cognito authorizer
    // ─────────────────────────────────────────────

    const authorizer = new apigw.CognitoUserPoolsAuthorizer(this, 'Authorizer', {
      cognitoUserPools: [userPool],
    });

    const api = new apigw.RestApi(this, 'Api', {
      restApiName: SERVICE_NAME,
      description: 'Bairro Promo REST API',
      deployOptions: {
        stageName: 'v1',
        tracingEnabled: true,
        metricsEnabled: true,
      },
      defaultCorsPreflightOptions: {
        allowOrigins: apigw.Cors.ALL_ORIGINS,
        allowHeaders: ['Content-Type', 'Authorization'],
        allowMethods: apigw.Cors.ALL_METHODS,
      },
    });

    const requireAuth: apigw.MethodOptions = {
      authorizer,
      authorizationType: apigw.AuthorizationType.COGNITO,
    };

    // ─────────────────────────────────────────────
    // API Routes Definition
    // ─────────────────────────────────────────────

    api.root
      .addResource('health')
      .addMethod('GET', new apigw.LambdaIntegration(healthFn)); // GET /health

    // category

    const categories = api.root.addResource('categories');
    categories.addMethod('GET', new apigw.LambdaIntegration(listCategoriesFn)); // GET /categories
    categories.addMethod('POST', new apigw.LambdaIntegration(addCategoryFn), requireAuth); // POST /categories
    categories
      .addResource('reorder')
      .addMethod('PATCH', new apigw.LambdaIntegration(reorderCategoriesFn), requireAuth); // PATCH /categories/reorder

    const categoryById = categories.addResource('{id}');
    categoryById.addMethod('GET', new apigw.LambdaIntegration(previewCategoryFn)); // GET /categories/{id}
    categoryById.addMethod('PUT', new apigw.LambdaIntegration(updateCategoryFn), requireAuth); // PUT /categories/{id}
    categoryById
      .addResource('enable')
      .addMethod('PATCH', new apigw.LambdaIntegration(enableCategoryFn), requireAuth); // PATCH /categories/{id}/enable
    categoryById
      .addResource('disable')
      .addMethod('PATCH', new apigw.LambdaIntegration(disableCategoryFn), requireAuth); // PATCH /categories/{id}/disable

    // place

    const places = api.root.addResource('places');
    places.addMethod('GET', new apigw.LambdaIntegration(listPlacesFn)); // GET /places
    places.addMethod('POST', new apigw.LambdaIntegration(addPlaceFn), requireAuth); // POST /places

    const placeById = places.addResource('{id}');
    placeById.addMethod('GET', new apigw.LambdaIntegration(previewPlaceFn)); // GET /places/{id}
    placeById.addMethod('PUT', new apigw.LambdaIntegration(updatePlaceFn), requireAuth); // PUT /places/{id}
    placeById
      .addResource('publish')
      .addMethod('PATCH', new apigw.LambdaIntegration(publishPlaceFn), requireAuth); // PATCH /places/{id}/publish
    placeById
      .addResource('unpublish')
      .addMethod('PATCH', new apigw.LambdaIntegration(unpublishPlaceFn), requireAuth); // PATCH /places/{id}/unpublish
    placeById
      .addResource('review')
      .addMethod('PATCH', new apigw.LambdaIntegration(reviewPlaceFn), requireAuth); // PATCH /places/{id}/review
    const placeImageType = placeById.addResource('images').addResource('{type}');
    placeImageType.addMethod('PATCH', new apigw.LambdaIntegration(uploadPlaceImageFn), requireAuth); // PATCH /places/{id}/images/{type}
    placeImageType
      .addResource('approve')
      .addMethod('PATCH', new apigw.LambdaIntegration(approvePlaceImageFn), requireAuth); // PATCH /places/{id}/images/{type}/approve

    // location

    const placeLocations = placeById.addResource('locations');
    placeLocations.addMethod('POST', new apigw.LambdaIntegration(addLocationFn), requireAuth); // POST /places/{id}/locations

    const placeLocationById = placeLocations.addResource('{locationId}');
    placeLocationById.addMethod('GET', new apigw.LambdaIntegration(previewLocationFn), requireAuth); // GET /places/{id}/locations/{locationId}
    placeLocationById.addMethod('PUT', new apigw.LambdaIntegration(updateLocationFn), requireAuth); // PUT /places/{id}/locations/{locationId}
    placeLocationById.addMethod('DELETE', new apigw.LambdaIntegration(removeLocationFn), requireAuth); // DELETE /places/{id}/locations/{locationId}

    // profile

    const profile = api.root.addResource('profile');
    profile.addMethod('POST', new apigw.LambdaIntegration(signupProfileFn), requireAuth); // POST /profile — called after Amplify Cognito signin, token already verified by Gateway
    profile.addMethod('GET', new apigw.LambdaIntegration(previewProfileFn), requireAuth); // GET /profile
    profile.addMethod('PUT', new apigw.LambdaIntegration(updateProfileFn), requireAuth); // PUT /profile
    profile
      .addResource('convert')
      .addMethod('PATCH', new apigw.LambdaIntegration(convertProfileFn), requireAuth); // PATCH /profile/convert

    // ─────────────────────────────────────────────
    // Outputs
    // ─────────────────────────────────────────────

    new cdk.CfnOutput(this, 'ApiUrl', { value: api.url });
    new cdk.CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: userPoolClient.userPoolClientId,
    });
    new cdk.CfnOutput(this, 'TableName', { value: table.tableName });
    new cdk.CfnOutput(this, 'ImagesBucketName', { value: imagesBucket.bucketName });
  }
}
