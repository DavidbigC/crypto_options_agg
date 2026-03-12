import { notFound } from 'next/navigation'
import OptimizerPageClient from './OptimizerPageClient'
import { isOptimizerEnabled } from '@/lib/publicRuntime.js'

export default function OptimizerPage() {
  if (!isOptimizerEnabled()) notFound()
  return <OptimizerPageClient />
}
