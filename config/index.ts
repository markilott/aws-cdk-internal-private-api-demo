export const options = {
    vpcAttr: {
        customVpcId: 'vpc-041765cd2f75a00cd',
        // These are the AWS default VPC subnets. Update to your own CIDR's if using a custom VPC
        // subnetCidr1: '10.174.211.0/26',
        // subnetCidr2: '10.174.211.64/26',
    },
    createCertificate: true,
    // certificate generated as described here https://gitlab.app.betfair/security/vault-access-control/#aws for the `.aws.private` PHZs that exist in all accounts
    certificateArn: 'arn:aws:acm:eu-west-1:764955193533:certificate/1b7390c8-7d9b-4e09-8ca4-22f0416b9464',
    dnsAttr: {
        zoneName: 'platformeng-dev.aws.private',
        hostedZoneId: 'Z09675033QVMZLAZV9RYL',
    },
    albHostname: 'detestadr',
    apiPath1: 'test-api1',
    apiPath2: 'test-api2',
};

