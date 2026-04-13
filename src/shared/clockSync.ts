export type ClockSync = ReturnType<typeof createClockSync>

const MAX_SAMPLES = 5
const OUTLIER_THRESHOLD = 5000

const createClockSync = () => {
	let clockOffset = 0
	const offsetSamples: number[] = []
	
	return {
		updateOffset(serverTime: number): void {
			const clientTime = Date.now()
			const newOffset = clientTime - serverTime
			
			if (offsetSamples.length > 0) {
				const currentAvg = offsetSamples.reduce((sum, val) => sum + val, 0) / offsetSamples.length
				const deviation = Math.abs(newOffset - currentAvg)
				
				if (deviation > OUTLIER_THRESHOLD) {
					console.log(
						'[CLIENT] Rejecting outlier offset sample:',
						Math.round(newOffset),
						'ms (deviation:',
						Math.round(deviation),
						'ms)'
					)
					return
				}
			}
			
			offsetSamples.push(newOffset)
			if (offsetSamples.length > MAX_SAMPLES) {
				offsetSamples.shift()
			}
			
			const avgOffset = offsetSamples.reduce((sum, val) => sum + val, 0) / offsetSamples.length
			clockOffset = avgOffset
			
			console.log(
				'[CLIENT] Clock offset updated:',
				Math.round(avgOffset),
				'ms (',
				Math.round(avgOffset / 1000),
				's) - samples:',
				offsetSamples.length
			)
		},
		
		getOffset(): number {
			return clockOffset
		},
		
		toLocalTime(serverTimestamp: number): number {
			return serverTimestamp + clockOffset
		}
	}
}

export const clockSync = createClockSync()