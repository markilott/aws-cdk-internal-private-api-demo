/* eslint-disable max-classes-per-file */
/* eslint-disable no-new */

import {
    Stack, StackProps, Duration, CfnOutput, Tags,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';
import {
    DomainName, RestApi, LambdaIntegration, BasePathMapping, SecurityPolicy, EndpointType,
    JsonSchemaVersion, JsonSchemaType,
} from 'aws-cdk-lib/aws-apigateway';
import { Function, Runtime, Code } from 'aws-cdk-lib/aws-lambda';
import {
    Vpc, SecurityGroup, CfnRouteTable, CfnSubnet, CfnSubnetRouteTableAssociation,
    CfnVPCEndpoint, Subnet, InterfaceVpcEndpoint, Peer, Port,
} from 'aws-cdk-lib/aws-ec2';
import { HostedZone, ARecord, RecordTarget } from 'aws-cdk-lib/aws-route53';
import { LoadBalancerTarget } from 'aws-cdk-lib/aws-route53-targets';
import { Certificate, CertificateValidation } from 'aws-cdk-lib/aws-certificatemanager';
import {
    ApplicationLoadBalancer, ApplicationProtocol, ApplicationTargetGroup, TargetType,
    ListenerAction, ListenerCondition,
} from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { IpTarget } from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import {
    PolicyDocument, PolicyStatement, AnyPrincipal, Effect,
} from 'aws-cdk-lib/aws-iam';
import { AwsCustomResource, AwsCustomResourcePolicy } from 'aws-cdk-lib/custom-resources';
import { options } from './options';

export class VpcStack extends Stack {
    vpcId: string;

    subnetId1: string;

    subnetId2: string;

    vpcEndpointId: string;

    endpointIpAddresses: string[];

    /**
     * Deploys the VPC API Endpoint into two new subnets.
     *
     * Uses custom CloudFormation resources (Lambda) to
     * retrieve the IP Addresses of the API Endpoint for use
     * in the Application stack.
     *
     * @param {Construct} scope
     * @param {string} id
     * @param {StackProps=} props
     */
    constructor(scope: Construct, id: string, props: StackProps | undefined) {
        super(scope, id, props);

        const { vpcAttr } = options;
        const { customVpcId, subnetCidr1, subnetCidr2 } = vpcAttr;

        // Check that the default subnets have been updated if we are using a custom VPC
        if (customVpcId && (subnetCidr1.includes('172.31.') || subnetCidr2.includes('172.31.'))) { throw new Error('Update the subnet CIDR Ranges in options if you are using a custom VPC'); }

        // Use an existing VPC if specified in options, or the default VPC if not
        const vpc = (customVpcId) ? Vpc.fromLookup(this, 'vpc', { vpcId: customVpcId }) : Vpc.fromLookup(this, 'vpc', { isDefault: true });
        const { vpcId, vpcCidrBlock, availabilityZones } = vpc;
        this.vpcId = vpcId;

        // security group for endpoint
        const apiEndPointSg = new SecurityGroup(this, 'ApiEndpointSg', {
            description: 'Internal API Endpoint SG',
            vpc,
            allowAllOutbound: true,
        });
        apiEndPointSg.addIngressRule(Peer.ipv4(vpcCidrBlock), Port.tcp(443), 'allow internal Endpoint access');

        // Using level1 Cfn constructs rather than L2 CDK as they are more flexible for custom VPC components

        // create two new private subnets for the API and ALB
        const routeTable = new CfnRouteTable(this, 'routeTable', { vpcId });
        const subnet1 = new CfnSubnet(this, 'subnet1', {
            cidrBlock: subnetCidr1,
            vpcId,
            mapPublicIpOnLaunch: false,
            availabilityZone: availabilityZones[0],
        });
        Tags.of(subnet1).add('Name', 'albDemoSubnet1');
        this.subnetId1 = subnet1.ref;
        new CfnSubnetRouteTableAssociation(this, 'assoc1', {
            routeTableId: routeTable.ref,
            subnetId: subnet1.ref,
        });
        const subnet2 = new CfnSubnet(this, 'subnet2', {
            cidrBlock: subnetCidr2,
            vpcId,
            mapPublicIpOnLaunch: false,
            availabilityZone: availabilityZones[1],
        });
        Tags.of(subnet2).add('Name', 'albDemoSubnet2');
        this.subnetId2 = subnet2.ref;
        new CfnSubnetRouteTableAssociation(this, 'assoc2', {
            routeTableId: routeTable.ref,
            subnetId: subnet2.ref,
        });

        // the API Endpoint. Will attach to the two new subnets
        const apiEndpoint = new CfnVPCEndpoint(this, 'apiEndpoint', {
            vpcId,
            serviceName: `com.amazonaws.${this.region}.execute-api`,
            privateDnsEnabled: true,
            vpcEndpointType: 'Interface',
            subnetIds: [subnet1.ref, subnet2.ref],
            securityGroupIds: [apiEndPointSg.securityGroupId],
        });
        this.vpcEndpointId = apiEndpoint.ref;
        new CfnOutput(this, 'apiEndpointId', {
            description: 'API Endpoint Id',
            value: apiEndpoint.ref,
        });

        // use CDK custom resources to get the Network Interfaces and IP addresses of the API Endpoint
        const vpcEndpointProps = new AwsCustomResource(this, 'vpcEndpointProps', {
            onUpdate: {
                service: 'EC2',
                action: 'describeVpcEndpoints',
                parameters: {
                    VpcEndpointIds: [apiEndpoint.ref],
                },
                physicalResourceId: {},
            },
            policy: AwsCustomResourcePolicy.fromSdkCalls({ resources: AwsCustomResourcePolicy.ANY_RESOURCE }),
            logRetention: 7,
        });
        const networkInterfaceProps = new AwsCustomResource(this, 'networkInterfaceProps', {
            onUpdate: {
                service: 'EC2',
                action: 'describeNetworkInterfaces',
                parameters: {
                    NetworkInterfaceIds: [
                        vpcEndpointProps.getResponseField('VpcEndpoints.0.NetworkInterfaceIds.0'),
                        vpcEndpointProps.getResponseField('VpcEndpoints.0.NetworkInterfaceIds.1'),
                    ],
                },
                physicalResourceId: {},
            },
            policy: AwsCustomResourcePolicy.fromSdkCalls({ resources: AwsCustomResourcePolicy.ANY_RESOURCE }),
            logRetention: 7,
        });
        this.endpointIpAddresses = [
            networkInterfaceProps.getResponseField('NetworkInterfaces.0.PrivateIpAddress'),
            networkInterfaceProps.getResponseField('NetworkInterfaces.1.PrivateIpAddress'),
        ];
    }
}

interface AplicationStackProps extends StackProps {
    vpcId: string,
    subnetId1: string,
    subnetId2: string,
    vpcEndpointId: string,
    endpointIpAddresses: string[],
}

export class AplicationStack extends Stack {
    /**
     * Deploys two simple API's with Lambda function and GET method.
     * API Url is output for use in testing.
     *
     * The ALB sits in front of the API's and includes a custom hostname
     * configured in Route53.
     *
     * @param {Construct} scope
     * @param {string} id
     * @param {StackProps=} props
     *
     */
    constructor(scope: Construct, id: string, props: AplicationStackProps) {
        super(scope, id, props);

        const {
            vpcId, subnetId1, subnetId2, vpcEndpointId, endpointIpAddresses,
        } = props;
        const {
            dnsAttr, createCertificate, albHostname, apiPath1, apiPath2, certificateArn,
        } = options;

        // Setup VPC, DNS and Certificate ==================================================================================================

        // VPC - from the VPC stack
        const vpc = Vpc.fromLookup(this, 'vpc', { vpcId });
        const subnet1 = Subnet.fromSubnetId(this, 'subnet1', subnetId1);
        const subnet2 = Subnet.fromSubnetId(this, 'subnet2', subnetId2);

        // DNS Zone
        const zone = HostedZone.fromHostedZoneAttributes(this, 'zone', dnsAttr);
        const { zoneName } = zone;

        // host and domain for the ALB URL
        const albDomainName = `${albHostname}.${zoneName}`;

        // Certificate
        // Creating a certificate will try to create auth records in the Route53 DNS zone.
        const certificate = (createCertificate && certificateArn)
            ? Certificate.fromCertificateArn(this, 'cert', certificateArn)
            : new Certificate(this, 'cert', {
                domainName: `*.${zoneName}`,
                validation: CertificateValidation.fromDns(zone),
            });

        // API VPC Endpoint
        const apiEndpoint = InterfaceVpcEndpoint.fromInterfaceVpcEndpointAttributes(this, 'apiEndpoint', { port: 443, vpcEndpointId });

        // Lambda function =================================================================================================================
        const lambdaFnc = new Function(this, 'lambdaFnc', {
            functionName: 'albTestFnc',
            code: Code.fromInline(
                `exports.handler = async (event) => {
                    /**
                     * Basic API response function.
                     * @param {object} context
                     * @param {string} context.requestId
                     */
                    console.log('Event: ', JSON.stringify(event));
                    return {
                        requestId: (event.context.requestId) || 'Missing requestId',
                    };
                };`,
            ),
            runtime: Runtime.NODEJS_14_X,
            handler: 'index.handler',
        });

        // API =============================================================================================================================

        // API IAM Policy
        const defApiPolicy = new PolicyDocument({
            // allow access to API only from the internal VPC endpoint
            statements: [
                new PolicyStatement({
                    principals: [new AnyPrincipal()],
                    actions: ['execute-api:Invoke'],
                    resources: ['execute-api:/*'],
                    effect: Effect.DENY,
                    conditions: {
                        StringNotEquals: {
                            'aws:SourceVpce': vpcEndpointId,
                        },
                    },
                }),
                new PolicyStatement({
                    principals: [new AnyPrincipal()],
                    actions: ['execute-api:Invoke'],
                    resources: ['execute-api:/*'],
                    effect: Effect.ALLOW,
                }),
            ],
        });

        // Create the API domain
        const apiDomain = new DomainName(this, 'apiDomain', {
            domainName: albDomainName,
            certificate,
            endpointType: EndpointType.REGIONAL, // API domains can only be created for Regional endpoints, but it will work with the Private endpoint anyway
            securityPolicy: SecurityPolicy.TLS_1_2,
        });

        // Model for the integration Method Responses
        const responseModelProps = {
            contentType: 'application/json',
            schema: {
                schema: JsonSchemaVersion.DRAFT7,
                title: 'JsonResponse',
                type: JsonSchemaType.OBJECT,
                properties: {
                    state: { type: JsonSchemaType.STRING },
                    greeting: { type: JsonSchemaType.STRING },
                },
            },
        };

        // API 1 ===========

        // Create API and deployment stage
        const api1 = new RestApi(this, 'albTestApi1', {
            restApiName: 'albTestApi1',
            description: 'The ALB Test Api1',
            deployOptions: {
                stageName: 'v1',
                description: 'V1 Deployment',
            },
            endpointConfiguration: {
                types: [EndpointType.PRIVATE],
                vpcEndpoints: [apiEndpoint],
            },
            policy: defApiPolicy,
        });
        const jsonResponseModel1 = api1.addModel('jsonResponse1', responseModelProps);

        // map API domain name to API
        new BasePathMapping(this, 'pathMapping1', {
            basePath: apiPath1,
            domainName: apiDomain,
            restApi: api1,
        });
        new CfnOutput(this, 'apiUrl1', {
            description: 'API Endpoint URL1',
            value: api1.url,
        });
        new CfnOutput(this, 'apiAlbUrl1', {
            description: 'API1 URL via ALB',
            value: `https://${albDomainName}/${apiPath1}`,
        });

        // Lambda integration for API method
        const lambdaInteg1 = new LambdaIntegration(lambdaFnc, {
            proxy: false,
            requestTemplates: {
                'application/json': `{
                    "context": {
                        "requestId" : "$context.requestId"
                    }
                }`,
            },
            integrationResponses: [{
                statusCode: '200',
                responseTemplates: {
                    'application/json': '$input.body',
                },
            }],
        });

        // API method at root
        api1.root.addMethod('GET', lambdaInteg1, {
            methodResponses: [{
                statusCode: '200',
                responseModels: {
                    'application/json': jsonResponseModel1,
                },
            }],
        });

        // API 2 ===========

        // Create API and deployment stage
        const api2 = new RestApi(this, 'albTestApi2', {
            restApiName: 'albTestApi2',
            description: 'The ALB Test Api2',
            deployOptions: {
                stageName: 'v1',
                description: 'V1 Deployment',
            },
            endpointConfiguration: {
                types: [EndpointType.PRIVATE],
                vpcEndpoints: [apiEndpoint],
            },
            policy: defApiPolicy,
        });
        const jsonResponseModel2 = api2.addModel('jsonResponse2', responseModelProps);

        // map API domain name to API
        new BasePathMapping(this, 'pathMapping2', {
            basePath: apiPath2,
            domainName: apiDomain,
            restApi: api2,
        });
        new CfnOutput(this, 'apiUrl2', {
            description: 'API Endpoint URL2',
            value: api2.url,
        });
        new CfnOutput(this, 'apiAlbUrl2', {
            description: 'API2 URL via ALB',
            value: `https://${albDomainName}/${apiPath2}`,
        });

        // Lambda integration for API method
        const lambdaInteg2 = new LambdaIntegration(lambdaFnc, {
            proxy: false,
            requestTemplates: {
                'application/json': `{
                    "context": {
                        "requestId" : "$context.requestId"
                    }
                }`,
            },
            integrationResponses: [{
                statusCode: '200',
                responseTemplates: {
                    'application/json': '$input.body',
                },
            }],
        });

        // API method at root
        api2.root.addMethod('GET', lambdaInteg2, {
            methodResponses: [{
                statusCode: '200',
                responseModels: {
                    'application/json': jsonResponseModel2,
                },
            }],
        });

        // ALB =============================================================================================================================

        // security group
        const albSg = new SecurityGroup(this, 'albSg', {
            description: 'ALB Endpoint SG',
            vpc,
            allowAllOutbound: true,
        });
        albSg.addIngressRule(Peer.ipv4(vpc.vpcCidrBlock), Port.tcp(443), 'allow internal ALB access');
        albSg.addIngressRule(Peer.ipv4(vpc.vpcCidrBlock), Port.tcp(80), 'allow internal ALB access');

        // load balancer base
        const alb = new ApplicationLoadBalancer(this, 'alb', {
            vpc,
            vpcSubnets: {
                subnets: [subnet1, subnet2],
            },
            internetFacing: false,
            securityGroup: albSg,
        });

        // listeners
        const https = alb.addListener('https', {
            port: 443,
            protocol: ApplicationProtocol.HTTPS,
            certificates: [certificate],
        });
        // addRedirect will create a HTTP listener and redirect to HTTPS
        alb.addRedirect({
            sourceProtocol: ApplicationProtocol.HTTP,
            sourcePort: 80,
            targetProtocol: ApplicationProtocol.HTTPS,
            targetPort: 443,
        });

        // DNS alias for ALB
        new ARecord(this, 'albAlias', {
            recordName: albDomainName,
            zone,
            comment: 'Alias for API ALB Demo',
            target: RecordTarget.fromAlias(new LoadBalancerTarget(alb)),
        });

        // add targets
        const ipTargets = endpointIpAddresses.map((ip) => new IpTarget(ip));
        const apiTargetGroup = new ApplicationTargetGroup(this, 'apiEndpointGroup', {
            targetGroupName: 'ApiEndpoints',
            port: 443,
            protocol: ApplicationProtocol.HTTPS,
            healthCheck: {
                path: '/',
                interval: Duration.minutes(5),
                healthyHttpCodes: '200-202,400-404',
            },
            targetType: TargetType.IP,
            targets: ipTargets,
            vpc,
        });

        // add routing actions. Send a 404 response if the request does not match one of our API paths
        https.addAction('default', {
            action: ListenerAction.fixedResponse(404, {
                contentType: 'text/plain',
                messageBody: 'Nothing to see here',
            }),
        });
        https.addAction('apis', {
            action: ListenerAction.forward([apiTargetGroup]),
            conditions: [
                ListenerCondition.pathPatterns([`/${apiPath1}`, `/${apiPath2}`]),
            ],
            priority: 1,
        });
    }
}
