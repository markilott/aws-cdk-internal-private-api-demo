/* eslint-disable max-classes-per-file */
/* eslint-disable no-new */

const {
    Duration, Stack, CfnOutput, Tags,
} = require('@aws-cdk/core');
const apigw = require('@aws-cdk/aws-apigateway');
const lambda = require('@aws-cdk/aws-lambda');
const ec2 = require('@aws-cdk/aws-ec2');
const route53 = require('@aws-cdk/aws-route53');
const targets = require('@aws-cdk/aws-route53-targets');
const acm = require('@aws-cdk/aws-certificatemanager');
const elb = require('@aws-cdk/aws-elasticloadbalancingv2');
const { IpTarget } = require('@aws-cdk/aws-elasticloadbalancingv2-targets');
const iam = require('@aws-cdk/aws-iam');
const { AwsCustomResource, AwsCustomResourcePolicy } = require('@aws-cdk/custom-resources');

class VpcStack extends Stack {
    /**
     * Deploys the VPC API Endpoint into two new subnets.
     *
     * Uses custom CloudFormation resources (Lambda) to
     * retrieve the IP Addresses of the API Endpoint for use
     * in the Application stack.
     *
     * @param {cdk.Construct} scope
     * @param {string} id
     * @param {cdk.StackProps=} props
     */
    constructor(scope, id, props) {
        super(scope, id, props);

        const { vpcAttr } = props.options;
        const { customVpcId, subnetCidr1, subnetCidr2 } = vpcAttr;

        // Check that the default subnets have been updated if we are using a custom VPC
        if (customVpcId && (subnetCidr1.includes('172.31.') || subnetCidr2.includes('172.31.'))) { throw new Error('Update the subnet CIDR Ranges in options if you are using a custom VPC'); }

        // Use an existing VPC if specified in options, or the default VPC if not
        const vpc = (customVpcId) ? ec2.Vpc.fromLookup(this, 'vpc', { vpcId: customVpcId }) : ec2.Vpc.fromLookup(this, 'vpc', { isDefault: true });
        const { vpcId, vpcCidrBlock, availabilityZones } = vpc;
        this.vpcId = vpcId;

        // security group for endpoint
        const apiEndPointSg = new ec2.SecurityGroup(this, 'ApiEndpointSg', {
            description: 'Internal API Endpoint SG',
            vpc,
            allowAllOutbound: true,
        });
        apiEndPointSg.addIngressRule(ec2.Peer.ipv4(vpcCidrBlock), ec2.Port.tcp(443), 'allow internal Endpoint access');

        // Using level1 Cfn constructs rather than L2 CDK as they are more flexible for custom VPC components

        // create two new private subnets for the API and ALB
        const routeTable = new ec2.CfnRouteTable(this, 'routeTable', { vpcId });
        const subnet1 = new ec2.CfnSubnet(this, 'subnet1', {
            cidrBlock: subnetCidr1,
            vpcId,
            mapPublicIpOnLaunch: false,
            availabilityZone: availabilityZones[0],
        });
        Tags.of(subnet1).add('Name', 'albDemoSubnet1');
        this.subnetId1 = subnet1.ref;
        new ec2.CfnSubnetRouteTableAssociation(this, 'assoc1', {
            routeTableId: routeTable.ref,
            subnetId: subnet1.ref,
        });
        const subnet2 = new ec2.CfnSubnet(this, 'subnet2', {
            cidrBlock: subnetCidr2,
            vpcId,
            mapPublicIpOnLaunch: false,
            availabilityZone: availabilityZones[1],
        });
        Tags.of(subnet2).add('Name', 'albDemoSubnet2');
        this.subnetId2 = subnet2.ref;
        new ec2.CfnSubnetRouteTableAssociation(this, 'assoc2', {
            routeTableId: routeTable.ref,
            subnetId: subnet2.ref,
        });

        // the API Endpoint. Will attach to the two new subnets
        const apiEndpoint = new ec2.CfnVPCEndpoint(this, 'apiEndpoint', {
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

class AplicationStack extends Stack {
    /**
     * Deploys two simple API's with Lambda function and GET method.
     * API Url is output for use in testing.
     *
     * The ALB sits in front of the API's and includes a custom hostname
     * configured in Route53.
     *
     * @param {cdk.Construct} scope
     * @param {string} id
     * @param {cdk.StackProps=} props
     */
    constructor(scope, id, props) {
        super(scope, id, props);

        const {
            options, vpcId, subnetId1, subnetId2, vpcEndpointId, endpointIpAddresses,
        } = props;
        const {
            dnsAttr, createCertificate, albHostname, apiPath1, apiPath2,
        } = options;

        // Setup VPC, DNS and Certificate ==================================================================================================

        // VPC - from the VPC stack
        const vpc = ec2.Vpc.fromLookup(this, 'vpc', { vpcId });
        const subnet1 = ec2.Subnet.fromSubnetId(this, 'subnet1', subnetId1);
        const subnet2 = ec2.Subnet.fromSubnetId(this, 'subnet2', subnetId2);

        // DNS Zone
        const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'zone', dnsAttr);
        const { zoneName } = zone;

        // host and domain for the ALB URL
        const albDomainName = `${albHostname}.${zoneName}`;

        // Certificate
        // Creating a certificate will try to create auth records in the Route53 DNS zone.
        let certificate = {};
        if (createCertificate) {
            certificate = new acm.Certificate(this, 'cert', {
                domainName: `*.${zoneName}`,
                validation: acm.CertificateValidation.fromDns(zone),
            });
        } else {
            certificate = acm.Certificate.fromCertificateArn(this, 'cert', options.certificateArn);
        }

        // API VPC Endpoint
        const apiEndpoint = ec2.InterfaceVpcEndpoint.fromInterfaceVpcEndpointAttributes(this, 'apiEndpoint', { port: 443, vpcEndpointId });

        // Lambda function =================================================================================================================
        const lambdaFnc = new lambda.Function(this, 'lambdaFnc', {
            functionName: 'albTestFnc',
            code: lambda.Code.fromInline(
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
            runtime: lambda.Runtime.NODEJS_12_X,
            handler: 'index.handler',
        });

        // API =============================================================================================================================

        // API IAM Policy
        const defApiPolicy = new iam.PolicyDocument({
            // allow access to API only from the internal VPC endpoint
            statements: [
                new iam.PolicyStatement({
                    principals: [new iam.AnyPrincipal()],
                    actions: ['execute-api:Invoke'],
                    resources: ['execute-api:/*'],
                    effect: iam.Effect.DENY,
                    conditions: {
                        StringNotEquals: {
                            'aws:SourceVpce': vpcEndpointId,
                        },
                    },
                }),
                new iam.PolicyStatement({
                    principals: [new iam.AnyPrincipal()],
                    actions: ['execute-api:Invoke'],
                    resources: ['execute-api:/*'],
                    effect: iam.Effect.ALLOW,
                }),
            ],
        });

        // Create the API domain
        const apiDomain = new apigw.DomainName(this, 'apiDomain', {
            domainName: albDomainName,
            certificate,
            endpointType: apigw.EndpointType.REGIONAL, // API domains can only be created for Regional endpoints, but it will work with the Private endpoint anyway
            securityPolicy: apigw.SecurityPolicy.TLS_1_2,
        });

        // API 1 ===========

        // Create API and deployment stage
        const api1 = new apigw.RestApi(this, 'albTestApi1', {
            restApiName: 'albTestApi1',
            description: 'The ALB Test Api1',
            deployOptions: {
                stageName: 'v1',
                description: 'V1 Deployment',
            },
            endpointConfiguration: {
                types: [apigw.EndpointType.PRIVATE],
                vpcEndpoints: [apiEndpoint],
            },
            policy: defApiPolicy,
        });

        // map API domain name to API
        new apigw.BasePathMapping(this, 'pathMapping1', {
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
        const lambdaInteg1 = new apigw.LambdaIntegration(lambdaFnc, {
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
                    'application/json': '$input.body',
                },
            }],
        });

        // API 2 ===========

        // Create API and deployment stage
        const api2 = new apigw.RestApi(this, 'albTestApi2', {
            restApiName: 'albTestApi2',
            description: 'The ALB Test Api2',
            deployOptions: {
                stageName: 'v1',
                description: 'V1 Deployment',
            },
            endpointConfiguration: {
                types: [apigw.EndpointType.PRIVATE],
                vpcEndpoints: [apiEndpoint],
            },
            policy: defApiPolicy,
        });

        // map API domain name to API
        new apigw.BasePathMapping(this, 'pathMapping2', {
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
        const lambdaInteg2 = new apigw.LambdaIntegration(lambdaFnc, {
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
                    'application/json': '$input.body',
                },
            }],
        });

        // ALB =============================================================================================================================

        // security group
        const albSg = new ec2.SecurityGroup(this, 'albSg', {
            description: 'ALB Endpoint SG',
            vpc,
            allowAllOutbound: true,
        });
        albSg.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(443), 'allow internal ALB access');
        albSg.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(80), 'allow internal ALB access');

        // load balancer base
        const alb = new elb.ApplicationLoadBalancer(this, 'alb', {
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
            protocol: elb.ApplicationProtocol.HTTPS,
            certificates: [certificate],
        });
        // addRedirect will create a HTTP listener and redirect to HTTPS
        alb.addRedirect({
            sourceProtocol: elb.ApplicationProtocol.HTTP,
            sourcePort: 80,
            targetProtocol: elb.ApplicationProtocol.HTTPS,
            targetPort: 443,
        });

        // DNS alias for ALB
        new route53.ARecord(this, 'albAlias', {
            recordName: albDomainName,
            zone,
            comment: 'Alias for API ALB Demo',
            target: route53.RecordTarget.fromAlias(new targets.LoadBalancerTarget(alb)),
        });

        // add targets
        const ipTargets = endpointIpAddresses.map((ip) => new IpTarget(ip));
        const apiTargetGroup = new elb.ApplicationTargetGroup(this, 'apiEndpointGroup', {
            targetGroupName: 'ApiEndpoints',
            port: 443,
            protocol: elb.ApplicationProtocol.HTTPS,
            healthCheck: {
                path: '/',
                interval: Duration.minutes(5),
                healthyHttpCodes: '200-202,400-404',
            },
            targetType: elb.TargetType.IP,
            targets: ipTargets,
            vpc,
        });

        // add routing actions. Send a 404 response if the request does not match one of our API paths
        https.addAction('default', {
            action: elb.ListenerAction.fixedResponse(404, {
                contentType: 'text/plain',
                messageBody: 'Nothing to see here',
            }),
        });
        https.addAction('apis', {
            action: elb.ListenerAction.forward([apiTargetGroup]),
            conditions: [
                elb.ListenerCondition.pathPatterns([`/${apiPath1}`, `/${apiPath2}`]),
            ],
            priority: 1,
        });
    }
}

module.exports = { VpcStack, AplicationStack };
