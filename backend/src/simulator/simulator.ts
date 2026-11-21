import { ipInCidr } from '../net/cidr';
import { Direction, portRangeOf, RuleSpec } from '../risk/risk';

export interface SimulatableRule extends RuleSpec {
  id: string;
  name: string;
}

export interface SimulationInput {
  sourceIp: string;
  protocol: RuleSpec['protocol'];
  port: number | null;
  direction?: Direction;
}

export interface SimulationResult {
  decision: 'ALLOW' | 'DENY';
  matchedRules: SimulatableRule[];
}

/**
 * Mengikuti Security Group AWS: default deny. ALLOW jika minimal satu rule dengan arah,
 * protocol, dan rentang port yang cocok, dan sourceIp berada di dalam CIDR-nya.
 */
export function simulate(rules: SimulatableRule[], input: SimulationInput): SimulationResult {
  const direction: Direction = input.direction ?? 'INGRESS';
  const matchedRules = rules.filter((rule) => {
    if ((rule.direction ?? 'INGRESS') !== direction) return false;
    if (rule.protocol !== input.protocol) return false;
    if (!ipInCidr(input.sourceIp, rule.cidr)) return false;
    if (rule.protocol === 'icmp') return true;
    const range = portRangeOf(rule);
    if (!range || input.port === null) return false;
    return input.port >= range.from && input.port <= range.to;
  });
  return { decision: matchedRules.length > 0 ? 'ALLOW' : 'DENY', matchedRules };
}
