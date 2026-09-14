export type IcpParameterKey = 'min_rms_decrease' | 'sampling_limit' | 'overlap' | 'random_seed';

export type IcpParameterValues = Record<IcpParameterKey, string>;

export function createIcpParameterValues(): IcpParameterValues {
  return { min_rms_decrease: '0.00001', sampling_limit: '50000', overlap: '1', random_seed: '42' };
}

export function updateIcpParameter(values: IcpParameterValues, key: string, value: string): void {
  if (key in values) values[key as IcpParameterKey] = value;
}
