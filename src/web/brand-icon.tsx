import { Boxes } from 'lucide-react';
import type { ProviderBrand } from '../shared/brand.js';
import zhipu from './assets/providers/zhipu.png';
import volcano from './assets/providers/volcano.png';
import deepseek from './assets/providers/deepseek.png';

const symbols = { zhipu, volcano, deepseek };

export function BrandIcon({ brand, className = '' }: { brand?: ProviderBrand; className?: string }) {
  return <span className={`brand-icon ${className}`} aria-hidden="true">
    {brand && symbols[brand] ? <img src={symbols[brand]} alt="" /> : <Boxes size={21} strokeWidth={1.6} />}
  </span>;
}
