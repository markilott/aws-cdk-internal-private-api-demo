export const options = {
    vpcAttr: {
        customVpcId: '',
        // These are the AWS default VPC subnets. Update to your own CIDR's if using a custom VPC
        subnetCidr1: '172.31.128.0/20',
        subnetCidr2: '172.31.144.0/20',
    },
    createCertificate: true,
    certificateArn: '',
    dnsAttr: {
        zoneName: 'mydomain.com',
        hostedZoneId: '',
    },
    albHostname: 'alb-test',
    apiPath1: 'test-api1',
    apiPath2: 'test-api2',
};
