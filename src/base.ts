import * as fs from 'fs-extra';
import { IOption, loadProto } from 'load-proto';
import { Options as LoaderOptions } from 'load-proto/build/loader';
import { get, set } from 'lodash';
import * as path from 'path';
import genGetGrpcClient from "./genGetGrpcClient";
import genGrpcObj from "./genGrpcObj";
import genServices from "./genServices";
import genServiceWrapper from "./genServiceWrapper";
import genTsType from "./genTsType";
import { inspectNamespace } from "./pbjs";
import { TNamespace } from "./types";
import { getAbsPath, getPackageName } from "./utils";

const BASE_DIR = path.join(process.cwd(), 'code-gen');

export interface Options extends IOption {
  baseDir?: string;
  target?: 'javascript' | 'typescript';
  configFilePath?: string;
  grpcNpmName?: string;
  loaderOptions?: LoaderOptions;
}

export async function gen(opt: Options): Promise<string> {
  const {
    baseDir = BASE_DIR,
    target = 'typescript',
    configFilePath,
    gitUrls,
    branch,
    accessToken,
    resolvePath,
    grpcNpmName = 'grpc',
    loaderOptions,
  } = opt;

  fs.removeSync(baseDir);
  console.info(`Clean dir: ${baseDir}`);

  fs.mkdirpSync(baseDir);

  if (gitUrls.length <= 1) {
    throw new Error('gitUrls must be more than two parameters');
  }

  const firstUrl = gitUrls.splice(0, 1)
  let allResult: Array<{ result: any, root: any, [propname: string]: any }> = []

  const json: any = await Promise.all(gitUrls.map(async (url) => {
    const newUrl: any = url
    const root = await loadProto({
      gitUrls: [...firstUrl, url],
      branch,
      accessToken,
      resolvePath,
    });
    root.resolveAll();
    const json: any = root.toJSON({ keepComments: true });
    delete json.nested.google
    delete json.nested.common

    const [space, service]: any[] = newUrl.match(/:.+-proto/)[0].replace(/:|-proto/g, '').split('/')

    allResult.push({
      result: inspectNamespace(root),
      root,
      space,
      service
    })

    return { space, service, json }
  }))


  fs.mkdirpSync(path.join(process.cwd(), '.grpc-code-gen'));

  const jsonPath = path.join(process.cwd(), '.grpc-code-gen', 'root.json');
  await fs.writeJSON(jsonPath, json);

  if (!allResult.length) {
    throw new Error('None code gen');
  }

  
  const grpcObjPath = getAbsPath(`grpcObj.ts`, baseDir);
  await fs.writeFile(
    grpcObjPath,
    genGrpcObj({
      grpcNpmName,
      configFilePath: configFilePath as string,
      grpcObjPath,
      jsonPath,
    }),
  );

  const grpcClientPath = getAbsPath(`getGrpcClient.ts`, baseDir);
  await fs.writeFile(
    grpcClientPath,
    genGetGrpcClient(grpcNpmName, grpcClientPath),
  );


  const serviceWrapperPath = getAbsPath(`serviceWrapper.ts`, baseDir);
  await fs.writeFile(
    serviceWrapperPath,
    genServiceWrapper({
      configFilePath: configFilePath as string,
      grpcNpmName,
      serviceWrapperPath,
    }),
  );


  // 先清空一次
  await fs.writeFile(getAbsPath('types.ts', baseDir), '');

  allResult.map((item: { result: any, root: any, [propname: string]: any }, index: number) => {
    
    const { result, root, space, service } = item
    const { services, methods, messages, enums } = result;

    const namespace: TNamespace = {};
    messages.forEach((message: any) => {
      const packageName = getPackageName(message.fullName);
      const nameSpacePath = 'nested.' + packageName.replace(/\./g, '.nested.');
      const latest = get(namespace, nameSpacePath, { messages: {} });
      latest.messages[message.name] = message;
      set(namespace, nameSpacePath, latest);
    });
    enums.forEach((enumT: any) => {
      const packageName = getPackageName(enumT.fullName);
      const nameSpacePath = 'nested.' + packageName.replace(/\./g, '.nested.');
      const latest = get(namespace, nameSpacePath, { enums: {} });
      latest.enums[enumT.name] = enumT;
      set(namespace, nameSpacePath, latest);
    });

    const typesPath = getAbsPath('types.ts', baseDir);
    fs.appendFile(
      typesPath,
      genTsType({ namespace, root, messages, enums, loaderOptions, space, service, index }),
    );

    genServices({
      grpcClientPath,
      serviceWrapperPath,
      messages,
      methods,
      grpcNpmName,
      configFilePath: configFilePath as string,
      grpcObjPath,
      baseDir,
      enums,
      root,
      services,
      typesPath,
      loaderOptions,
      space,
      service
    });

  })




  console.info(`Generate success in ${baseDir}`);

  return baseDir;
}
