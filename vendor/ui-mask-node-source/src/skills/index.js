import { VideoInputSkill } from './VideoInputSkill.js';
import { FpsConvertSkill } from './FpsConvertSkill.js';
import { UiMaskSkill } from './UiMaskSkill.js';
import { VideoPreviewSkill } from './VideoPreviewSkill.js';
import { VideoExportSkill } from './VideoExportSkill.js';

/**
 * 统一技能注册表
 */
export const SkillRegistry = {
  list: [
    {
      name: '视频输入',
      class: VideoInputSkill,
      type: 'input',
      outputType: 'video'
    },
    {
      name: '帧率转换',
      class: FpsConvertSkill,
      type: 'process',
      inputType: 'video',
      outputType: 'video'
    },
    {
      name: 'UI遮罩',
      class: UiMaskSkill,
      type: 'process',
      inputType: 'video',
      outputType: 'video'
    },
    {
      name: '视频预览',
      class: VideoPreviewSkill,
      type: 'output',
      inputType: 'video',
      outputType: 'video'
    },
    {
      name: '视频导出',
      class: VideoExportSkill,
      type: 'output',
      inputType: 'video',
      outputType: 'file'
    }
  ],

  getByOutputType(outputType) {
    // 返回所有inputType匹配的技能，加上所有分组（不管inputType）
    return this.list.filter(skill => 
      skill.type === 'group' || skill.inputType === outputType
    );
  },

  getByClass(className) {
    return this.list.find(s => s.class?.name === className);
  }
};
