var url = require('url');
var urlencode = require("urlencode");
var str = "dubbo://172.16.160.30:9130/com.dcits.ensemble.service.common.iconfirm.IWarnBatch?anyhost=trued&alication=smartnsembldult.mt=000=2.3.2&&intertace=com.dcits.ensemble.service.common.iconfirm./Warnbatch&&logger=sif4|&&methods=authorizebatchwrn&&owner=dcts&&pid=2408&&revision=15.3.0-SNAPSHOT&&side=provider&&threads=100&&timestamp=16/2833010185";
var str2 = "dubbo%3A%2F%2F172.16.160.28%3A9130%2Fcom.dcits.ensemble.service.common.iconfirm.IWarnBatch%3Fanyhost%3Dtrue%26application%3DSmartEnsemble%26default.timeout%3D500000%26dubbo%3D2.3.2%26interface%3Dcom.dcits.ensemble.service.common.iconfirm.IWarnBatch%26logger%3Dslf4j%26methods%3DauthorizeBatchWrn%26owner%3Ddcits%26pid%3D26427%26revision%3D15.3.0-SNAPSHOT%26side%3Dprovider%26threads%3D100%26timestamp%3D1672833041809";


//console.log(url.parse(str));
console.log(url.parse(str).host);
console.log(url.parse(urlencode.decode(str2)).host);