import * as sns from '@aws-cdk/aws-sns';
import * as sqs from '@aws-cdk/aws-sqs';
import * as cdk from '@aws-cdk/core';
import { RegionInfo, FactName } from '@aws-cdk/region-info';
import {CfnCustomResource, CfnOutput} from "@aws-cdk/core";
import * as kms from '@aws-cdk/aws-kms';
import * as iam from '@aws-cdk/aws-iam';
import * as s3 from '@aws-cdk/aws-s3';
import * as lambda from '@aws-cdk/aws-lambda';
import {DeadLetterQueue, IQueue} from "@aws-cdk/aws-sqs";
import {SqsEventSource} from '@aws-cdk/aws-lambda-event-sources';
import {CfnFunction, CfnVersion} from "@aws-cdk/aws-lambda";
import {LambdaDestination} from '@aws-cdk/aws-s3-notifications';
import {NotificationKeyFilter} from "@aws-cdk/aws-s3";
import * as events from '@aws-cdk/aws-events';
import * as targets from '@aws-cdk/aws-events-targets';
import {AccountPrincipal} from "@aws-cdk/aws-iam";
import {EmailSubscription} from "@aws-cdk/aws-sns-subscriptions";

const __version__ = '2.3.2'
console.log(__version__);

export class SiemOnEsStack extends cdk.Stack {

  makeAccountPrincipals(scope:cdk.Construct, orgMgmtId:string, orgMemberIds:string, noOrgIds:string):AccountPrincipal[] {
    let awsIds = [orgMgmtId, orgMemberIds, noOrgIds].filter(item => item && item !== "");
    let accountPrincipals:AccountPrincipal[] = [];
    for (let awsId in  awsIds) {
      accountPrincipals.push( new iam.AccountPrincipal(awsId) );
    }
    return accountPrincipals;
  }

  makeResourceList(scope:cdk.Construct, path:string, tail:string, keys:string[]):string[] {
    let awsIds = keys.filter(item => item && item !== "");
    let multiS3path = [];
    for (let awsId in awsIds)
      multiS3path.push(path + awsId + tail)
    return multiS3path;
  }

  constructor(scope: cdk.App, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    //https://awscdk.io/packages/@aws-cdk/region-info@1.111.0/#/./@aws-cdk_region-info.FactName

    const RESOURCE_SUFFIX:string = this.node.tryGetContext('resource_suffix');
    const ES_LOADER_TIMEOUT = 600;
    /**
     * ELB Mapping
     */
    let elbIdTemp: string = FactName.ELBV2_ACCOUNT;
    let elbMapTemp:{[region: string]: string} = RegionInfo.regionMap(elbIdTemp);

    const elbAccounts = new cdk.CfnMapping(this, 'ELBv2AccountMap');
    for(let key of Object.keys(elbMapTemp)) {
      elbAccounts.setValue(key,'accountid',elbMapTemp[key])
    }
     /**
     * Get params
     */
    const allowSourceAddress = new cdk.CfnParameter(this, 'AllowedSourceIpAddresses', {
      allowedPattern: '^[0-9./\\s]*',
      description: 'Space-delimited list of CIDR blocks',
      default: '10.0.0.0/8 172.16.0.0/12 192.168.0.0/16'
    });
    const snsEmail = new cdk.CfnParameter(this, 'SnsEmail', {
      allowedPattern: '^[0-9a-zA-Z@_\\-\\+\\.]*',
      description: 'Input your email as SNS topic, where Amazon ES will send alerts to',
      default: 'user+sns@example.com'
    });
    const geoipLicenseKey = new cdk.CfnParameter(this, 'GeoLite2LicenseKey', {
      allowedPattern: '^[0-9a-zA-Z]{16}$',
      description: 'If you would like to enrich geoip locaiton such as IP address\'s country, get a license key form MaxMind and input the key. If you not, keep "xxxxxxxxxxxxxxxx"',
      default: 'xxxxxxxxxxxxxxxx'
    });
    const reservedConcurrency = new cdk.CfnParameter(this, 'ReservedConcurrency', {
      description: 'Input reserved concurrency. Increase this value if there are steady logs delay despite no errors',
      default: 10,
      type: 'Number'
    });

    const aesDomainName = this.node.tryGetContext('aes_domain_name')+RESOURCE_SUFFIX;
    const bucket:string = `${aesDomainName}-${cdk.Aws.ACCOUNT_ID}`;
    let s3bucketNameGeo:string = `${bucket}-geo`+RESOURCE_SUFFIX;
    let s3bucketNameLog:string = `${bucket}-log`+RESOURCE_SUFFIX;
    let s3bucketNameSnapshot:string = `${bucket}-snapshot`+RESOURCE_SUFFIX;



    // organizations / multiaccount
    const orgId = this.node.tryGetContext('organizations')?.org_id;
    const orgMgmtId = this.node.tryGetContext('organizations')?.management_id;
    const orgMemberIds = this.node.tryGetContext('organizations')?.member_ids;
    const noOrgIds = this.node.tryGetContext('no_organizations')?.aws_accounts;


    //Overwrite default S3 bucket name as customer name
    const tempGeo = this.node.tryGetContext('s3_bucket_name')?.geo+RESOURCE_SUFFIX;
    if(tempGeo) {
      s3bucketNameGeo = tempGeo;
    } else {
      console.log('Using default Geo bucket names')
    }
    const tempLog = this.node.tryGetContext('s3_bucket_name')?.log+RESOURCE_SUFFIX;
    if(tempLog) {
      s3bucketNameLog = tempLog;
    } else if(orgId || noOrgIds) {
      s3bucketNameLog = `${aesDomainName}-${this.account}-log`;
    } else {
      console.log('Using default Log bucket names');
    }
    const tempSnapshot = this.node.tryGetContext('s3_bucket_name')?.snapshot+RESOURCE_SUFFIX;
    if(tempSnapshot) {
      s3bucketNameSnapshot = tempSnapshot;
    } else {
      console.log('Using default Snapshot bucket names');
    }
    let kmsCmkAlias:string = this.node.tryGetContext('kms_cmk_alias');
    if(!kmsCmkAlias) {
      kmsCmkAlias = 'aes-siem-key-999';
      console.log('Using default key alais');
    }

    /**
     * Create cmk of KMS to encrypt S3 bucket
     */

    let kmsAesSiem = new kms.Key(this, 'KmsAesSiemLog', {
      description: 'CMK for SIEM solution',
      removalPolicy: cdk.RemovalPolicy.RETAIN
    });

    new kms.Alias(this, 'KmsAesSiemLogAlias', {
      aliasName: kmsCmkAlias+RESOURCE_SUFFIX,
      targetKey: kmsAesSiem,
      removalPolicy: cdk.RemovalPolicy.RETAIN
    });
    //guardduty policy
    kmsAesSiem.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'Allow GuardDuty to use the key',
      actions: ['kms:GenerateDataKey'],
      principals: [ new iam.ServicePrincipal('guardduty.amazonaws.com') ],
      resources: ['*'],
    }));
    //vpc flow log policy
    kmsAesSiem.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'Allow VPC Flow Logs to use the key',
      actions: ['kms:Encrypt', 'kms:Decrypt', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:DescribeKey'],
      principals: [ new iam.ServicePrincipal('delivery.logs.amazonaws.com') ],
      resources: ['*'],
    }));
    //basic policy
    let keyPolicyBasic1 = new iam.PolicyStatement({
      sid: 'Allow principals in the account to decrypt log files',
      actions: ['kms:DescribeKey', 'kms:ReEncryptFrom'],
      principals: [ new iam.AccountPrincipal(cdk.Aws.ACCOUNT_ID) ],
      resources: ['*']
    });
    kmsAesSiem.addToResourcePolicy(keyPolicyBasic1);
    //athena policy
    let keyPolicyAthena = new iam.PolicyStatement({
      sid:'Allow Athena to query s3 objects with this key',
      actions: ['kms:Decrypt', 'kms:DescribeKey', 'kms:Encrypt', 'kms:GenerateDataKey*', 'kms:ReEncrypt*'],
      principals: [ new iam.AccountPrincipal(cdk.Aws.ACCOUNT_ID)],
      resources:['*'],
      conditions: { 'ForAnyValue:StringEquals' : {'aws:CalledVia': 'athena.amazonaws.com'}}
    });
    kmsAesSiem.addToResourcePolicy(keyPolicyAthena);
    //cloudtrail policy
    let keyPolicyTrail1 = new iam.PolicyStatement({
      sid: 'Allow CloudTrail to describe key',
      actions: ['kms:DescribeKey'],
      principals: [ new iam.ServicePrincipal('cloudtrail.amazonaws.com') ],
      resources: ['*'],
    });
    kmsAesSiem.addToResourcePolicy(keyPolicyTrail1);
    let keyPolicyTrail2 = new iam.PolicyStatement({
      sid: 'Allow CloudTrail to encrypt logs',
      actions: ['kms:GenerateDataKey*'],
      principals: [ new iam.ServicePrincipal('cloudtrail.amazonaws.com') ],
      resources: ['*'],
      conditions: { 'StringLike' : {
                        'kms:EncryptionContext:aws:cloudtrail:arn': [
                               `arn:aws:cloudtrail:*:${cdk.Aws.ACCOUNT_ID}:trail/*`]}}  //ERROR
    });
    kmsAesSiem.addToResourcePolicy(keyPolicyTrail2);


    // create s3 bucket
    let blockPub = new s3.BlockPublicAccess({
      blockPublicAcls: true,
      ignorePublicAcls: true,
      blockPublicPolicy: true,
      restrictPublicBuckets: true
    });
    let s3Geo = new s3.Bucket(this, 'S3BucketForGeoip', {
      blockPublicAccess: blockPub,
      bucketName: s3bucketNameGeo,
      // removalPolicy: cdk.RemovalPolicy.DESTROY
    });
    let s3Log = new s3.Bucket(this, 'S3BucketForLog', { //ERROR  SSEAlgorithm: AES256
      blockPublicAccess: blockPub,
      bucketName: s3bucketNameLog,
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED
    });
    let s3Snapshot = new s3.Bucket(this, 'S3BucketForSnapshot', {
      blockPublicAccess: blockPub,
      bucketName: s3bucketNameSnapshot
    });


    /**
     * IAM role
     */
    //delopyment policy for lambda deploy-aes
    let arnPrefix = `arn:aws:logs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}`;
    let loggroupAes = `log-group:/aws/aes/domains/${aesDomainName}/*`;
    let loggroupLambda = `log-group:/aws/lambda/aes-siem-*`;

    let policydocCreateLoggroupStatements = [
      new iam.PolicyStatement({
      actions: [ 'logs:PutResourcePolicy', 'logs:DescribeLogGroups', 'logs:DescribeLogStreams' ],
      resources: [ `${arnPrefix}:*` ]
      }),
      new iam.PolicyStatement({
        actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents', 'logs:PutRetentionPolicy'],
        resources: [`${arnPrefix}:${loggroupAes}`, `${arnPrefix}:${loggroupLambda}`]
      })];
    let policydocCreateLoggroup = new iam.PolicyDocument({
      statements: policydocCreateLoggroupStatements,
    });

    let policydocCrhelperStatements =  [new iam.PolicyStatement({
      actions: [ 'lambda:AddPermission', 'lambda:RemovePermission', 'events:ListRules',
        'events:PutRule', 'events:DeleteRule', 'events:PutTargets', 'events:RemoveTargets'],
      resources: ['*']
    })];
    let policydocCrhelper = new iam.PolicyDocument({
      statements: policydocCrhelperStatements
    });
    //snapshot rule
    let policydocSnapshotStatements = [
      new iam.PolicyStatement({
        actions: ['s3:ListBucket'],
        resources: [s3Snapshot.bucketArn]
      }),
      new iam.PolicyStatement({
        actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
        resources: [s3Snapshot.bucketArn+'/*']
      })
    ];
    let policydocSnapshot = new iam.PolicyDocument({
      statements: policydocSnapshotStatements
    });

    let aesSiemSnapshotRole = new iam.Role(this, 'AesSiemSnapshotRole', {
      roleName: 'aes-siem-snapshot-role'+RESOURCE_SUFFIX,
      inlinePolicies: { "0" : policydocSnapshot },  //TODO
      assumedBy: new iam.ServicePrincipal('es.amazonaws.com')
    });

    let policydocAssumeSnapshrole = new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          actions: ['iam:PassRole'],
          resources: [aesSiemSnapshotRole.roleArn]
        })
      ]
    });

    // let aesSiemDeployRoleForLambdaDocument =
    new iam.PolicyDocument({
      statements:[
        ...policydocCreateLoggroupStatements,
        ...policydocCrhelperStatements,
        ...policydocSnapshotStatements
      ]
    })
    let aesSiemDeployRoleForLambda = new iam.Role(this, 'AesSiemDeployRoleForLambda', {
      roleName: 'aes-siem-deploy-role-for-lambda'+RESOURCE_SUFFIX,
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonESFullAccess'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')
      ],
      inlinePolicies: {
        "0": policydocAssumeSnapshrole,
        "1": policydocSnapshot,
        "2": policydocCreateLoggroup,
        "3": policydocCrhelper }, //TODO
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com')
    });

    //for alert from ES
    let aesSiemSnsRole = new iam.Role(this, 'AesSiemSnsRole', {
      roleName: 'aes-siem-sns-role'+RESOURCE_SUFFIX,
      assumedBy: new iam.ServicePrincipal('es.amazonaws.com')
    });

    // EC2 role
    let aesSiemEsLoaderEc2Role = new iam.Role(this, 'AesSiemEsLoaderEC2Role', {
      roleName: 'aes-siem-es-loader-for-ec2'+RESOURCE_SUFFIX,
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com')
    });

    new iam.CfnInstanceProfile(this, 'AesSiemEsLoaderEC2InstanceProfile', {
      instanceProfileName: aesSiemEsLoaderEc2Role.roleName,
      roles: [aesSiemEsLoaderEc2Role.roleName]
    });

    /**
     * SQS for es-laoder's DLQ
     */
    let sqsAesSiemDlq = new sqs.Queue(this, 'AesSiemDlq', {
      queueName: 'aes-siem-dlq'+RESOURCE_SUFFIX,
      retentionPeriod: cdk.Duration.days(14)
    });

    let TempDLQ = new class implements DeadLetterQueue {
      readonly maxReceiveCount: number;
      readonly queue: IQueue;

      constructor() {
        this.maxReceiveCount = 2;
        this.queue = sqsAesSiemDlq;
      }
    }

    let sqsAesSiemSplittedLogs = new sqs.Queue(this, 'AesSiemSqsSplitLogs', {
      queueName: 'aes-siem-sqs-splitted-logs'+RESOURCE_SUFFIX,
      deadLetterQueue: TempDLQ,
      visibilityTimeout: cdk.Duration.seconds(ES_LOADER_TIMEOUT),
      retentionPeriod: cdk.Duration.days(14)
    });

    /**
     * Setup lambda
     */
    // setup lambda of es_loader

    let lambdaEsLoader = new lambda.Function(this, 'LambdaEsLoader', {  // VPC 설정관련 항목 제외 : 상단의 lambdaEsLoaderVpcKwargs.. 안사용할꺼야
      functionName: 'aes-siem-es-loader'+RESOURCE_SUFFIX,
      runtime: lambda.Runtime.PYTHON_3_8,
      code: lambda.Code.fromAsset('lambda/es_loader'),
      handler: 'index.lambda_handler',
      memorySize: 2048,
      timeout: cdk.Duration.seconds(ES_LOADER_TIMEOUT),
      reservedConcurrentExecutions: reservedConcurrency.valueAsNumber,
      deadLetterQueueEnabled: true,
      deadLetterQueue: sqsAesSiemDlq,
      environment: {
        'GEOIP_BUCKET': s3bucketNameGeo, 'LOG_LEVEL': 'info',
        'POWERTOOLS_LOGGER_LOG_EVENT': 'false',
        'POWERTOOLS_SERVICE_NAME': 'es-loader',
        'POWERTOOLS_METRICS_NAMESPACE': 'SIEM'
      },
      currentVersionOptions: {
        description: __version__,
      }
    });

    let esLoaderNewver = lambdaEsLoader.addVersion(__version__,undefined,__version__);
    let esLoaderOpt = esLoaderNewver.node.defaultChild as CfnVersion;
    esLoaderOpt.cfnOptions.deletionPolicy = cdk.CfnDeletionPolicy.RETAIN;

    // send only
    // sqs_aes_siem_dlq.grant(lambda_es_loader, 'sqs:SendMessage')
    // send and reieve. but it must be loop
    sqsAesSiemDlq.grant(lambdaEsLoader, 'sqs:SendMessage', 'sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:GetQueueAttributes');
    sqsAesSiemSplittedLogs.grant(lambdaEsLoader, 'sqs:SendMessage', 'sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:GetQueueAttributes');

    lambdaEsLoader.addEventSource( new SqsEventSource( sqsAesSiemSplittedLogs, {
      batchSize: 1
    }));

    //es-loader on EC2 role
    sqsAesSiemDlq.grant(aesSiemEsLoaderEc2Role, 'sqs:GetQueue*', 'sqs:ListQueues*', 'sqs:ReceiveMessage*', 'sqs:DeleteMessage*');

    let lambdaGeo = new lambda.Function(this, 'LambdaGeoipDownloader', {
      functionName: 'aes-siem-geoip-downloader'+RESOURCE_SUFFIX,
      runtime: lambda.Runtime.PYTHON_3_8,
      code: lambda.Code.fromAsset('lambda/geoip_downloader'),
      handler: 'index.lambda_handler',
      memorySize:320,
      timeout: cdk.Duration.seconds(300),
      environment: {
        's3bucket_name': s3bucketNameGeo,
        'license_key': geoipLicenseKey.valueAsString
      }
    });


    let lambdaGeoNewver = lambdaGeo.addVersion(__version__,undefined,__version__);
    let lambdaGeoOpt = lambdaGeoNewver.node.defaultChild as CfnVersion;
    lambdaGeoOpt.cfnOptions.deletionPolicy = cdk.CfnDeletionPolicy.RETAIN;

    /**
     *  setup elasticsearch
     */
    let lambdaDeployEs = new lambda.Function( this, 'LambdaDeployAES', {
      functionName: 'aes-siem-deploy-aes'+RESOURCE_SUFFIX,
      runtime: lambda.Runtime.PYTHON_3_8,
    // code: aws_lambda.Code.asset('../lambda/deploy_es.zip'),
      code: lambda.Code.fromAsset('lambda/deploy_es'),
      handler: 'index.aes_domain_handler',
      memorySize: 128,
      timeout: cdk.Duration.seconds(300),
      environment: {
        'accountid': cdk.Aws.ACCOUNT_ID,
        'aes_domain_name': aesDomainName,
        'aes_admin_role': aesSiemDeployRoleForLambda.roleArn,
        'es_loader_role': lambdaEsLoader.role?.roleArn ?? '',
        'allow_source_address': allowSourceAddress.valueAsString,
      },
      role: aesSiemDeployRoleForLambda
    });
    lambdaDeployEs.addEnvironment('s3_snapshot', s3Snapshot.bucketName);

    lambdaDeployEs.addEnvironment('vpc_subnet_id', 'None');
    lambdaDeployEs.addEnvironment('security_group_id', 'None');

    let deployEsNewver = lambdaDeployEs.addVersion(__version__,undefined,__version__);
    let deployEsOpt = deployEsNewver.node.defaultChild as CfnFunction;
    deployEsOpt.cfnOptions.deletionPolicy = cdk.CfnDeletionPolicy.RETAIN;

    let aesDomain = new CfnCustomResource(this, 'AesSiemDomainDeployedR2'+RESOURCE_SUFFIX, {
      serviceToken: lambdaDeployEs.functionArn
    });
    aesDomain.addOverride('Properties.ConfigVersion', __version__);

    let esEndpoint = aesDomain.getAtt('es_endpoint').toString();
    lambdaEsLoader.addEnvironment('ES_ENDPOINT', esEndpoint);
    lambdaEsLoader.addEnvironment('SQS_SPLITTED_LOGS_URL',sqsAesSiemSplittedLogs.queueUrl);

    let lambdaConfigureEs = new lambda.Function(this, 'LambdaConfigureAES', {
      functionName:'aes-siem-configure-aes'+RESOURCE_SUFFIX,
      runtime:lambda.Runtime.PYTHON_3_8,
      code:lambda.Code.fromAsset('lambda/deploy_es'),
      handler:'index.aes_config_handler',
      memorySize:128,
      timeout:cdk.Duration.seconds(300),
      environment:{
        'accountid': cdk.Aws.ACCOUNT_ID,
        'aes_domain_name': aesDomainName,
        'aes_admin_role': aesSiemDeployRoleForLambda.roleArn,
        //@ts-ignore
        'es_loader_role': lambdaEsLoader.role?.roleArn,
        'allow_source_address': allowSourceAddress.valueAsString,
        'es_endpoint': esEndpoint,
      },
      role:aesSiemDeployRoleForLambda,
      currentVersionOptions: {
        description: __version__
      }
    });
    lambdaConfigureEs.addEnvironment('s3_snapshot', s3Snapshot.bucketName);


    lambdaConfigureEs.addEnvironment('vpc_subnet_id', 'None');
    lambdaConfigureEs.addEnvironment('security_group_id', 'None');


    let configureEsNewver = lambdaConfigureEs.addVersion(__version__,undefined,__version__);
    let configureEsOpt = configureEsNewver.node.defaultChild as CfnVersion;
    configureEsOpt.cfnOptions.deletionPolicy = cdk.CfnDeletionPolicy.RETAIN;

    let aesConfig = new CfnCustomResource(this, 'AesSiemDomainConfiguredR2'+RESOURCE_SUFFIX, {
      serviceToken: lambdaConfigureEs.functionArn
    });
    aesConfig.addOverride('Properties.ConfigVersion', __version__);
    aesConfig.addDependsOn(aesDomain);
    aesConfig.cfnOptions.deletionPolicy = cdk.CfnDeletionPolicy.RETAIN;

    let esArn = `arn:aws:es:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:domain/${aesDomainName}`;
    let inlinePolicyToLoadEntriesIntoEs = new iam.Policy( this, 'aes-siem-policy-to-load-entries-to-es', {
        policyName:'aes-siem-policy-to-load-entries-to-es'+RESOURCE_SUFFIX,
        statements: [
          new iam.PolicyStatement({
            actions: ['es:*'],
            resources: [esArn + '/*']
          })
        ]
      }
    );

    lambdaEsLoader.role?.attachInlinePolicy(inlinePolicyToLoadEntriesIntoEs);
    aesSiemEsLoaderEc2Role.attachInlinePolicy(inlinePolicyToLoadEntriesIntoEs);

    //grant additional permission to es_loader role
    let additionalKmsCmks = this.node.tryGetContext('additional_kms_cmks');
    if(additionalKmsCmks?.length > 0) {
      let inlinePolicyAccessToAdditionalCmks = new iam.Policy( this, 'access_to_additional_cmks', {
          policyName: 'access_to_additional_cmks'+RESOURCE_SUFFIX,
          statements: [
            new iam.PolicyStatement({
              actions : ['kms:Decrypt'],
              resources : additionalKmsCmks//Array.from(new Set(additionalKmsCmks)).sort()
            })
          ]
      });
      lambdaEsLoader.role?.attachInlinePolicy(inlinePolicyAccessToAdditionalCmks);
      aesSiemEsLoaderEc2Role.attachInlinePolicy(inlinePolicyAccessToAdditionalCmks);
    }

    let additionalBuckets = this.node.tryGetContext('additional_s3_buckets');
    if(additionalBuckets?.length > 0) {
      let bucketsList = [];
      for (let bucket in additionalBuckets) {
        bucketsList.push(`arn:aws:s3:::${bucket}`);
        bucketsList.push(`arn:aws:s3:::${bucket}/*`);
      }
      let inlinePolicyAccessToAdditionalBuckets = new iam.Policy( this, 'access_to_additional_buckets',{
          policyName : 'access_to_additional_buckets'+RESOURCE_SUFFIX,
          statements : [
            new iam.PolicyStatement({
              actions: ['s3:GetObject*', 's3:GetBucket*', 's3:List*'],
              resources: Array.from(new Set(bucketsList)).sort()
            })
          ]
        }
      )
      lambdaEsLoader.role?.attachInlinePolicy(inlinePolicyAccessToAdditionalBuckets);
      aesSiemEsLoaderEc2Role.attachInlinePolicy(inlinePolicyAccessToAdditionalBuckets);
    }

    kmsAesSiem.grant(lambdaEsLoader, 'kms:Decrypt');
    kmsAesSiem.grant(aesSiemEsLoaderEc2Role, 'kms:Decrypt');

    if(lambdaEsLoader.role) {
      let keyPolicyambdaEsLoader = new iam.PolicyStatement({
        actions: ['kms:Decrypt'],
        principals: [lambdaEsLoader.role],
        resources: ['*']
      });
      kmsAesSiem.addToResourcePolicy(keyPolicyambdaEsLoader);
    }
    let keyPolicyaAsSiemEsLoaderEc2Role = new iam.PolicyStatement({
      actions: ['kms:Decrypt'],
      principals: [ aesSiemEsLoaderEc2Role ],
      resources: ['*']
    });
    kmsAesSiem.addToResourcePolicy(keyPolicyaAsSiemEsLoaderEc2Role);

    /**
     * s3 notification and grant permisssion
     */
    s3Geo.grantReadWrite(lambdaGeo);
    s3Geo.grantRead(lambdaEsLoader);
    s3Geo.grantRead(aesSiemEsLoaderEc2Role);
    s3Log.grantRead(lambdaEsLoader);
    s3Log.grantRead(aesSiemEsLoaderEc2Role);

    // create s3 notification for es_loader
    let notification = new LambdaDestination(lambdaEsLoader); //ERROR Managed: true


    // assign notification for the s3 PUT event type
    // most log system use PUT, but also CLB use POST & Multipart Upload
    class notiKeyFilter implements NotificationKeyFilter {
      readonly prefix?: string;
      constructor(pre:string) {
        this.prefix = pre;
      }
    }
    // assign notification for the s3 PUT event type
    // most log system use PUT, but also CLB use POST & Multipart Upload
    s3Log.addEventNotification(s3.EventType.OBJECT_CREATED, notification, new notiKeyFilter('AWSLogs/'));
    // For user logs, not AWS logs
    s3Log.addEventNotification(s3.EventType.OBJECT_CREATED, notification, new notiKeyFilter('UserLogs/'));

    //Download geoip to S3 once by executing lambda_geo
    let getGeoDb = new CfnCustomResource(this, 'ExecLambdaGeoipDownloader'+RESOURCE_SUFFIX, {
      serviceToken: lambdaGeo.functionArn
    });
    getGeoDb.cfnOptions.deletionPolicy = cdk.CfnDeletionPolicy.RETAIN;

    //Download geoip every day at 6PM UTC
    let rule = new events.Rule(this, 'CwlRuleLambdaGeoipDownloaderDilly', {
      schedule: events.Schedule.rate(cdk.Duration.hours(12))
    });
    rule.addTarget(new targets.LambdaFunction(lambdaGeo));

    /**
     * bucket policy
     */

    let s3Awspath = s3Log.bucketArn + '/AWSLogs/' + cdk.Aws.ACCOUNT_ID;
    let bucketPolicyCommon1 = new iam.PolicyStatement({
      sid:'ELB Policy',
      principals:[ new iam.AccountPrincipal(elbAccounts.findInMap(cdk.Aws.REGION, 'accountid')) ],
      actions:['s3:PutObject'],
      resources:[s3Awspath + '/*']
    });
    //NLB / ALB / R53resolver / VPC Flow Logs
    let bucketPolicyElb1 = new iam.PolicyStatement({
      sid:'AWSLogDeliveryAclCheck For ALB NLB R53Resolver Flowlogs',
      principals:[new iam.ServicePrincipal('delivery.logs.amazonaws.com')],
      actions:['s3:GetBucketAcl', 's3:ListBucket'],
      resources:[s3Log.bucketArn]
    });
    let bucketPolicyElb2 = new iam.PolicyStatement({
      sid:'AWSLogDeliveryWrite For ALB NLB R53Resolver Flowlogs',
      principals:[new iam.ServicePrincipal('delivery.logs.amazonaws.com')],
      actions:['s3:PutObject'],
      resources:[s3Awspath+'/*'],
      conditions: {'StringEquals': {'s3:x-amz-acl': 'bucket-owner-full-control'}}
    });
    s3Log.addToResourcePolicy(bucketPolicyCommon1);
    s3Log.addToResourcePolicy(bucketPolicyElb1);
    s3Log.addToResourcePolicy(bucketPolicyElb2);

    //CloudTrail
    let bucketPolicyTrail1 = new iam.PolicyStatement({
      sid : 'AWSLogDeliveryAclCheck For Cloudtrail',
      principals : [new iam.ServicePrincipal('cloudtrail.amazonaws.com')],
      actions : ['s3:GetBucketAcl'], resources : [s3Log.bucketArn],
    });
    let bucketPolicyTrail2 = new iam.PolicyStatement({
      sid : 'AWSLogDeliveryWrite For CloudTrail',
      principals : [new iam.ServicePrincipal('cloudtrail.amazonaws.com')],
      actions : ['s3:PutObject'], resources : [s3Awspath + '/*'],
      conditions : {
        'StringEquals': {'s3:x-amz-acl': 'bucket-owner-full-control'}
      }
    });
    s3Log.addToResourcePolicy(bucketPolicyTrail1);
    s3Log.addToResourcePolicy(bucketPolicyTrail2);

    // GuardDuty
    let bucketPolicyGd1 = new iam.PolicyStatement({
      sid: 'Allow GuardDuty to use the getBucketLocation operation',
      principals: [new iam.ServicePrincipal('guardduty.amazonaws.com')],
      actions: ['s3:GetBucketLocation'], resources: [s3Log.bucketArn],
    })
    let bucketPolicyGd2 = new iam.PolicyStatement({
      sid :'Allow GuardDuty to upload objects to the bucket',
      principals : [new iam.ServicePrincipal('guardduty.amazonaws.com')],
      actions : ['s3:PutObject'], resources: [s3Log.bucketArn + '/*'],
    })
    let bucketPolicyGd5 = new iam.PolicyStatement({
      sid: 'Deny non-HTTPS access', effect : iam.Effect.DENY,
      actions :['s3:*'], resources :[s3Log.bucketArn + '/*'],
      conditions : {'Bool': {'aws:SecureTransport': 'false'}}
    })
    bucketPolicyGd5.addAnyPrincipal();
    s3Log.addToResourcePolicy(bucketPolicyGd1);
    s3Log.addToResourcePolicy(bucketPolicyGd2);
    s3Log.addToResourcePolicy(bucketPolicyGd5);


    // Config
    let bucketPolicyConfig1 = new iam.PolicyStatement({
      sid :'AWSConfig BucketPermissionsCheck and BucketExistenceCheck',
      principals : [new iam.ServicePrincipal('config.amazonaws.com')],
      actions : ['s3:GetBucketAcl', 's3:ListBucket'],
      resources: [s3Log.bucketArn],
    });
    let bucketPolicyConfig2 =  new iam.PolicyStatement({
      sid : 'AWSConfigBucketDelivery',
      principals : [new iam.ServicePrincipal('config.amazonaws.com')],
      actions: ['s3:PutObject'], resources : [s3Awspath + '/Config/*'],
      conditions : {
        'StringEquals': {'s3:x-amz-acl': 'bucket-owner-full-control'}
      }
    });
    s3Log.addToResourcePolicy(bucketPolicyConfig1);
    s3Log.addToResourcePolicy(bucketPolicyConfig2);

    // geoip

    let bucketPolicyGeo1 = new iam.PolicyStatement({
      sid: 'Allow geoip downloader and es-loader to read/write',
      // @ts-ignore
      principals: [lambdaEsLoader.role, lambdaGeo.role],
      actions:['s3:PutObject', 's3:GetObject', 's3:DeleteObject'],
      resources: [s3Geo.bucketArn + '/*'],});
    s3Geo.addToResourcePolicy(bucketPolicyGeo1);

    // ES Snapshot
    let bucketPolicySnapshot = new iam.PolicyStatement({
      sid: 'Allow ES to store snapshot',
      principals: [aesSiemSnapshotRole],
      actions : ['s3:PutObject', 's3:GetObject', 's3:DeleteObject'],
      resources: [s3Snapshot.bucketArn + '/*'],})
    s3Snapshot.addToResourcePolicy(bucketPolicySnapshot);


    //for multiaccount / organizaitons
    if( orgId || (noOrgIds && noOrgIds.length > 0 )) {
      /**
       * KMS key policy for multiaccount / organizaitons
       */
      // for CloudTrail
      let condTrail2 = this.makeResourceList(this, 'arn:aws:cloudtrail:*:', ':trail/*',
          [orgMgmtId, ...noOrgIds]
      );
      let keyPolicyMulTrail2 = new iam.PolicyStatement({
        sid: 'Allow CloudTrail to encrypt logs for multiaccounts',
        actions: ['kms:GenerateDataKey*'],
        principals: [new iam.ServicePrincipal('cloudtrail.amazonaws.com')],
        resources: ['*'],
        conditions: {
          'StringLike': {
            'kms:EncryptionContext:aws:cloudtrail:arn': condTrail2
          }
        }
      })
      kmsAesSiem.addToResourcePolicy(keyPolicyMulTrail2);

      // for replicaiton
      let keyPolicyRep1 = new iam.PolicyStatement({
        sid: 'Enable cross account encrypt access for S3 Cross Region Replication',
        actions: ['kms:Encrypt'],
        principals: this.makeAccountPrincipals(this, orgMgmtId, orgMemberIds, noOrgIds),
        resources: ['*'],
      })
      kmsAesSiem.addToResourcePolicy(keyPolicyRep1);

      // ##################################################################
      // # Buckdet Policy for multiaccount / organizaitons
      // ##################################################################
      let s3LogBucketArn = 'arn:aws:s3:::' + s3bucketNameLog;

      // for CloudTrail
      let s3Mulpaths = this.makeResourceList(this, `${s3LogBucketArn}/AWSLogs/`, '/*',
        [orgId, orgMgmtId, noOrgIds]);
      let bucketPolicyOrgTrail = new iam.PolicyStatement({
        sid: 'AWSCloudTrailWrite for Multiaccounts / Organizations',
        principals: [
          new iam.ServicePrincipal('cloudtrail.amazonaws.com')],
        actions: ['s3:PutObject'], resources: s3Mulpaths,
        conditions: {
          'StringEquals': {
            's3:x-amz-acl': 'bucket-owner-full-control'
          }
        }
      });
      s3Log.addToResourcePolicy(bucketPolicyOrgTrail);

      // config
      let s3ConfMultpaths = this.makeResourceList(this, `${s3LogBucketArn}/AWSLogs/`, '/Config/*',
        [orgId, orgMgmtId, noOrgIds]);
      let bucketPolicyMulConfig2 = new iam.PolicyStatement({
        sid: 'AWSConfigBucketDelivery',
        principals: [new iam.ServicePrincipal('config.amazonaws.com')],
        actions: ['s3:PutObject'], resources: s3ConfMultpaths,
        conditions: {
          'StringEquals': {
            's3:x-amz-acl': 'bucket-owner-full-control'
          }
        }
      })
      s3Log.addToResourcePolicy(bucketPolicyMulConfig2);

      // for replication
      let bucketPolicyRep1 = new iam.PolicyStatement({
        sid : 'PolicyForDestinationBucket / Permissions on objects',
        principals : this.makeAccountPrincipals(scope, orgMgmtId, orgMemberIds, noOrgIds),
        actions : ['s3:ReplicateDelete', 's3:ReplicateObject',
          's3:ReplicateTags', 's3:GetObjectVersionTagging',
          's3:ObjectOwnerOverrideToBucketOwner'],
        resources : [`${s3LogBucketArn}/*`]
      });

      let bucketPolicyRep2 = new iam.PolicyStatement({
        sid : 'PolicyForDestinationBucket / Permissions on bucket',
        principals : this.makeAccountPrincipals(scope, orgMgmtId, orgMemberIds, noOrgIds),
        actions : ['s3:List*', 's3:GetBucketVersioning','s3:PutBucketVersioning'],
        resources : [`${s3LogBucketArn}`]
      })
      s3Log.addToResourcePolicy(bucketPolicyRep1);
      s3Log.addToResourcePolicy(bucketPolicyRep2);
    }

    /**
     * SNS topic for Amazon ES Alert
     */
    let snsTopic = new sns.Topic(this, 'SnsTopic', {
      topicName: 'aes-siem-alert'+RESOURCE_SUFFIX,
      displayName: 'AES SIEM'
    });
    snsTopic.addSubscription( new EmailSubscription(snsEmail.valueAsString));
    snsTopic.grantPublish(aesSiemSnsRole);

    /**
     * output of CFn
     */
    let kibanaurl = `https://${esEndpoint}/_plugin/kibana/`;
    let kibanaadmin = aesDomain.getAtt('kibanaadmin').toString();
    let kibanapass = aesDomain.getAtt('kibanapass').toString();

    new CfnOutput(this, 'RoleDeploy', {
      exportName :'role-deploy'+RESOURCE_SUFFIX,
      value : aesSiemDeployRoleForLambda.roleArn
    });
    new CfnOutput(this, 'KibanaUrl', {
      exportName :'kibana-url'+RESOURCE_SUFFIX,
      value : kibanaurl
    });
    new CfnOutput(this, 'KibanaPassword', {
      exportName : 'kibana-pass'+RESOURCE_SUFFIX,
      value : kibanapass,
      description : 'Please change the password in Kibana ASAP'
    });
    new CfnOutput(this, 'KibanaAdmin', {
      exportName : 'kibana-admin'+RESOURCE_SUFFIX,
      value : kibanaadmin
    });


  }
}
