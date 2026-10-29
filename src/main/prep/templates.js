// @ts-check
'use strict';
// Built-in session templates for the prep window. A template only pre-fills the session form and the
// answer preferences; it never adds facts.

const TEMPLATES = Object.freeze([
  {
    id: 'behavioral-interview', name: 'Job interview (behavioral)', meetingType: 'Job interview', durationMin: 45, mode: 'auto',
    preferences: { length: 'medium', tone: 'conversational', star: 'auto', technicalDepth: 'standard', fillerIntensity: 'subtle' },
    summary: 'Who: \nRole: \nPurpose: behavioral interview\nWhat they care about: ',
  },
  {
    id: 'technical-interview', name: 'Technical interview', meetingType: 'Technical interview', durationMin: 60, mode: 'auto',
    preferences: { length: 'medium', tone: 'professional', star: 'manual', technicalDepth: 'deep', fillerIntensity: 'subtle' },
    summary: 'Who: \nRole: \nStack: \nPurpose: technical interview',
  },
  {
    id: 'recruiter-screen', name: 'Recruiter screen', meetingType: 'Recruiter screen', durationMin: 30, mode: 'auto',
    preferences: { length: 'short', tone: 'professional', star: 'manual', technicalDepth: 'light', fillerIntensity: 'subtle' },
    summary: 'Who: \nCompany: \nRole: \nPurpose: first screen',
  },
  {
    id: 'research-meeting', name: 'Research meeting', meetingType: 'Research meeting', durationMin: 60, mode: 'manual',
    preferences: { length: 'long', tone: 'professional', star: 'manual', technicalDepth: 'deep', fillerIntensity: 'none' },
    summary: 'Who: \nTheir work: \nPurpose: ',
  },
  {
    id: 'networking-chat', name: 'Networking chat', meetingType: 'Networking', durationMin: 30, mode: 'manual',
    preferences: { length: 'short', tone: 'conversational', star: 'disabled', technicalDepth: 'standard', fillerIntensity: 'subtle' },
    summary: 'Who: \nWhere they work: \nPurpose: ',
  },
]);

module.exports = { TEMPLATES };
