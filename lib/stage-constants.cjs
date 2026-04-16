'use strict';

const PIPELINE_STAGES = ['spec', 'plan', 'code', 'review', 'build', 'ship', 'verify'];
const STAGE_RESULT_STAGES = [...PIPELINE_STAGES, 'vllm-opt'];
const FEATURE_PHASES = [...PIPELINE_STAGES, 'test', 'debug', 'dev', 'completed', 'vllm-opt'];

module.exports = {
  PIPELINE_STAGES,
  STAGE_RESULT_STAGES,
  FEATURE_PHASES,
};
