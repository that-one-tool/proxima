import { Proxima } from '@that-one-tool/proxima-core';
import { prefixRedisKeys, removePrefixFromRedisResponse } from './resp-handling';

const proxima = new Proxima({ level: 'debug' });

proxima.addTransformers(prefixRedisKeys, removePrefixFromRedisResponse).start();
