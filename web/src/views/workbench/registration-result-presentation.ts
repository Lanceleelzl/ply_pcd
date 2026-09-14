import type { RegistrationResult } from '../../api/contracts';
import { formatMatrix } from './matrix-display.ts';

export function registrationResultGroups(result: RegistrationResult | null, direction: string) {
  if (!result) return [];
  const forward = direction === 'a_to_b';
  const source = forward ? 'a' : 'b';
  const target = forward ? 'b' : 'a';
  const items = [{
    key: 'business', label: '业务场景转换矩阵', reverseLabel: '反向业务场景矩阵',
    title: `业务场景转换矩阵：模型 ${source.toUpperCase()} → 模型 ${target.toUpperCase()}（含预设）`,
    formula: `p_business_${target} = M_business_${source}_to_${target} × p_business_${source}`,
    forward: formatMatrix(forward ? result.a_to_b : result.b_to_a),
    inverse: formatMatrix(forward ? result.b_to_a : result.a_to_b),
  }];
  const file = forward ? result.file_a_to_b : result.file_b_to_a;
  const inverse = forward ? result.file_b_to_a : result.file_a_to_b;
  if (file && inverse) items.push({
    key: 'file', label: '原始模型坐标转换矩阵', reverseLabel: '反向原始模型矩阵',
    title: `原始模型坐标转换矩阵：模型 ${source.toUpperCase()} → 模型 ${target.toUpperCase()}`,
    formula: `p_file_${target} = M_file_${source}_to_${target} × p_file_${source}`,
    forward: formatMatrix(file), inverse: formatMatrix(inverse),
  });
  return items;
}
