export const options = {
    vpcAttr: {
        customVpcId: '',
        // These are the AWS default VPC subnets. Update to your own CIDR's if using a custom VPC
        subnetCidr1: '172.31.128.0/20',
        subnetCidr2: '172.31.144.0/20',
    },
    createCertificate: false,
    certificateArn: 'arn:aws:acm:ap-southeast-1:532634703125:certificate/6fc48374-ea2a-46a0-bcef-1c65ae54799b',
    dnsAttr: {
        zoneName: 'dev.occasional.cloud',
        hostedZoneId: 'Z08143971EEI6WZCBMR6K',
    },
    albHostname: 'alb-test',
    apiPath1: 'test-api1',
    apiPath2: 'test-api2',
};
