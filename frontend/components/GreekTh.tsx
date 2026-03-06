import { ReactNode } from 'react'

interface GreekThProps {
  symbol: string
  name: string
  description: string
  align?: 'left' | 'right' | 'center'
  className?: string
}

export default function GreekTh({ symbol, name, description, align = 'right', className = '' }: GreekThProps) {
  return (
    <th className={`relative group cursor-help font-medium ${className}`}>
      {symbol}
      <div className={`
        pointer-events-none absolute top-full mt-1.5 z-50
        hidden group-hover:block
        bg-gray-900 dark:bg-gray-700 text-white text-[11px] rounded px-2.5 py-1.5
        shadow-lg whitespace-nowrap
        ${align === 'right' ? 'right-0' : align === 'left' ? 'left-0' : 'left-1/2 -translate-x-1/2'}
      `}>
        <div className={`
          absolute bottom-full w-0 h-0
          border-l-4 border-r-4 border-b-4
          border-l-transparent border-r-transparent border-b-gray-900 dark:border-b-gray-700
          ${align === 'right' ? 'right-2' : align === 'left' ? 'left-2' : 'left-1/2 -translate-x-1/2'}
        `} />
        <span className="font-semibold">{name}</span>
        <span className="text-gray-300 dark:text-gray-400"> — {description}</span>
      </div>
    </th>
  )
}
