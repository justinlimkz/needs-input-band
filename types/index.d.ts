export type Item = {
  id: string
  title: string
  url: string
  decisions: number
  addedAt: number
  openHash: string
  clearedHash?: string
}

declare module 'claude-code' {
  interface PluginState {
    'needs-input-band': {
      items: Item[]
      isHidden: boolean
      label: string
      now: number
      touched: string[]
      others: number
    }
  }
}
