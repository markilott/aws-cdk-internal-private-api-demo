/**
 * Will deploy into the current default CLI account.
 *
 * Deployment:
 * cdk deploy --all
 */

/* eslint-disable no-new */
import 'source-map-support/register';
import { App } from 'aws-cdk-lib';
import { AplicationStack, VpcStack } from '../lib/application/application-stack';
import { options } from '../lib/application/options';

// validate options
const { vpcAttr, dnsAttr } = options;
if (!options.certificateArn && !options.createCertificate) { throw new Error('We must either create a new certificate or supply an existing certifcate ARN'); }
if (!vpcAttr.subnetCidr1 || !vpcAttr.subnetCidr2) { throw new Error('We need both subnet CIDR ranges (and they must be valid for the VPC CIDR)'); }
if (!dnsAttr.hostedZoneId || !dnsAttr.zoneName) { throw new Error('We need both the DNS zone name (domain name) and the Zone Id from Route53'); }
if (!options.albHostname || !options.apiPath1 || !options.apiPath2 || options.apiPath1 === options.apiPath2) { throw new Error('We need the ALB hostname and the api paths. API paths must be unique'); }

const app = new App();

// use account details from default AWS CLI credentials:
const account = process.env.CDK_DEFAULT_ACCOUNT;
const region = process.env.CDK_DEFAULT_REGION;

// Create VPC resource stack
const vpcStack = new VpcStack(app, 'AlbVpcDemoStack', {
    description: 'ALB VPC Demo Stack',
    env: { account, region },
});
const {
    subnetId1, subnetId2, vpcId, vpcEndpointId, endpointIpAddresses,
} = vpcStack;

// Create API and ALB resource stack
new AplicationStack(app, 'AlbApiDemoStack', {
    description: 'ALB API Demo Stack',
    env: { account, region },
    vpcId,
    subnetId1,
    subnetId2,
    vpcEndpointId,
    endpointIpAddresses,
});
