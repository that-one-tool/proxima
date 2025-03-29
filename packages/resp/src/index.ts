import { Proxima } from '@that-one-tool/proxima-core';
import { prefixRedisKeys, removePrefixFromRedisResponse } from './resp-handling';

const proxima = new Proxima();

proxima.addTransformers(prefixRedisKeys, removePrefixFromRedisResponse).start();
