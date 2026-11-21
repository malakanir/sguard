import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { RulesService } from '../rules/rules.service';
import { findPreset, PRESETS, PresetRule } from './presets';

@Injectable()
export class PresetsService {
  constructor(private readonly rules: RulesService) {}

  list() {
    return PRESETS.map(({ rules, ...preset }) => ({
      ...preset,
      rules: rules.map(({ name, protocol, port, sourceCidr }) => ({ name, protocol, port, sourceCidr })),
    }));
  }

  /**
   * Terapkan preset ke group. Rule yang sudah ada (protocol, port, CIDR sama) dilewati,
   * jadi preset aman dijalankan dua kali.
   */
  async apply(userId: string, groupId: string, presetId: string, sourceCidr?: string) {
    const preset = findPreset(presetId);
    if (!preset) throw new NotFoundException('Preset tidak ditemukan.');

    const created: string[] = [];
    const skipped: string[] = [];
    for (const rule of preset.rules) {
      try {
        await this.rules.create(userId, groupId, this.toDto(rule, sourceCidr));
        created.push(rule.name);
      } catch (err) {
        if (err instanceof ConflictException) {
          skipped.push(rule.name);
          continue;
        }
        throw err;
      }
    }
    return { preset: preset.id, created, skipped };
  }

  private toDto(rule: PresetRule, sourceCidr?: string) {
    return {
      name: rule.name,
      protocol: rule.protocol,
      port: rule.port,
      cidr: sourceCidr ?? rule.sourceCidr,
      description: rule.description,
    };
  }
}
