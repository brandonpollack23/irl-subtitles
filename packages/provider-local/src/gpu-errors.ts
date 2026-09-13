/** WebGPU device loss surfaces as these errors; callers dispose sessions and degrade (plan.md §6.1). */
export function isGpuFailure(e: unknown): boolean {
  return /device.*lost|GPUDevice|webgpu|out of memory|OOM|mapAsync|D3D|Metal/i.test(String(e));
}
