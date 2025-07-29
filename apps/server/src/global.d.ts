declare namespace NodeJS {
  interface Global {
    worker?: any;
    webRtcServer?: any;
    router?: any;
    transport?: any;
    producer?: any;
    consumer?: any;
  }
}

declare var worker: any;
declare var webRtcServer: any;
declare var router: any;
declare var transport: any;
declare var producer: any;
declare var consumer: any;
