/**
 * Regression cover for the FI-response false positives and the duplicate results found
 * in the 2026-08-10 audit (docs/fi-pipeline-audit-2026-08-10.md).
 *
 * Every fixture marked "PRODUCTION" is real data taken from the Atlas cluster. The worst
 * one is project 403501: report FI_1786352405931_fmnr44qki delivered two files that were
 * themselves the completed acoustic report answering the RFI to an acoustics consultancy,
 * as a live lead.
 *
 * The classifier is deterministic by default (no OpenAI call), so these run offline.
 */

const fiDetectionService = require('../fiDetectionService');
const scanJobProcessor = require('../scanJobProcessor');
const { normalizeReportType, getQuoteTerms } = require('../reportTypes');

const classify = (text, fileName, reportType = 'acoustic') =>
  fiDetectionService.classifyFIResponse(text, fileName, reportType);

describe('classifyFIResponse - responses that must veto the project', () => {
  test('PRODUCTION 403501: acoustic report answering the RFI, sold to WD Acoustics', async () => {
    const verdict = await classify(
      'this report responds to items relating to noise within the request for further ' +
      'information (rfi) under council ref. pf/0422/26. items within the rfi relating to ' +
      'amenity areas and inward noise impact are addressed below.',
      '20e72bd350d45c69b39b93cb7fa2e9e6-noisevibrationassessment-rfinote.pdf'
    );
    expect(verdict.isResponse).toBe(true);
  });

  test('PRODUCTION 406529: consultant already engaged - filename has no separators', async () => {
    const verdict = await classify(
      'wave dynamics have been engaged by mihai ional elvis to undertake a planning stage ' +
      'noise impact assessment for the change of use of domestic dwelling',
      '5ae61f3b867c3c7a713b0bf11035999a-wda251110lt_a_01noiseimpactassessmentfiresponse.pdf'
    );
    expect(verdict.isResponse).toBe(true);
    expect(verdict.source).toBe('filename');
  });

  test('PRODUCTION 405998: "firesponseletter" is caught despite no word separators', async () => {
    const verdict = await classify(
      'any details of rock extraction should provide details with regard to related noise',
      '926ac4ede31af9bf000e451688d88ffc-25-163firesponseletter.pdf'
    );
    expect(verdict.isResponse).toBe(true);
  });

  test('PRODUCTION 359353: FI already satisfied - "the applicant has provided"', async () => {
    const verdict = await classify(
      'noise impact assessment environment report further information page 6 of 8 the ' +
      'applicant has provided a noise impact assessment, based on the number of animals proposed.',
      '40272f1216938e780c03a3cfa33fe1f1-2974218_PlanningReport.pdf'
    );
    expect(verdict.isResponse).toBe(true);
  });

  test('PRODUCTION 411230: consultant appointed and submission awaited', async () => {
    const verdict = await classify(
      'environmental health note the applicant has appointed an acoustic consultant and ' +
      'environmental health await submission of an acoustic report.',
      '0214--3-.pdf'
    );
    expect(verdict.isResponse).toBe(true);
  });

  test('PRODUCTION 401040: consultee reviewing a report already submitted', async () => {
    const verdict = await classify(
      // Verbatim from the stored match, OCR spacing and all
      'lester acoustics, mrl/ 1773/l01, da ted 26 th february 2026 the environmental health ' +
      'department have had the chance to review the document referred to above and would ' +
      'provide the following comments',
      'environmental-health-response-03.03.2026.pdf'
    );
    expect(verdict.isResponse).toBe(true);
  });

  test('PRODUCTION 384778: the FI response quoting the original request', async () => {
    const verdict = await classify(
      'the applicant was requested to provide the following information in relation to the ' +
      'impact of noise. this report responds to that request.',
      'c91ed6b86f4ffcc6c8ff5c2082582ebd-D25A_0462_WEB_Env_Enf_FI.docx'
    );
    expect(verdict.isResponse).toBe(true);
  });

  test('PRODUCTION 421691: applicant already proposes to submit the report', async () => {
    const verdict = await classify(
      'the applicant proposes to submit a noise impact assessment, lighting impact ' +
      'assessment, traffic / parking note, drainage/suds note.',
      '7c77ae0e7050c00e93824e1b306f7664-pre-planningresponse.pdf'
    );
    expect(verdict.isResponse).toBe(true);
  });
});

describe('classifyFIResponse - genuine requests that must survive', () => {
  test('PRODUCTION 384778: the original request must NOT be vetoed', async () => {
    const verdict = await classify(
      'further information comprehensive noise impact assessment for aerial delivery hub. ' +
      'the applicant is required to submit a comprehensive noise impact assessment (nia) ' +
      'for the proposed development.',
      '8f542c1009cd2354603e7e3f84036130-D25A_0462_WEB_Env_Enf_Report.docx'
    );
    expect(verdict.isResponse).toBe(false);
  });

  test('PRODUCTION 413689: a file literally named Further-Information-Request', async () => {
    const verdict = await classify(
      'to enable the planning authority give further consideration to your application, you ' +
      'are requested to submit the following further information: noise assessment.',
      'b010e502417ae1b149154b7715f3c211-260979-Further-Information-Request.pdf'
    );
    expect(verdict.isResponse).toBe(false);
  });

  test('a request signed off "Kind regards" is not a response', async () => {
    const verdict = await classify(
      'the applicant is requested to carry out a noise assessment for the proposed ' +
      'development. Kind regards, John Murphy, Environmental Health Officer',
      'letter.pdf'
    );
    expect(verdict.isResponse).toBe(false);
  });

  test('a consultee recommendation is a lead, not a response', async () => {
    const verdict = await classify(
      'environmental health would recommend the applicant submits a noise impact assessment ' +
      'for the proposed development.',
      'planner-report.pdf'
    );
    expect(verdict.isResponse).toBe(false);
  });

  test('an unrelated item having "been submitted" does not veto', async () => {
    const verdict = await classify(
      'The site layout plan has been submitted and is acceptable. However the applicant is ' +
      'requested to carry out a noise assessment for the development.',
      'planner-report.pdf'
    );
    expect(verdict.isResponse).toBe(false);
  });

  test('a cover note enclosing the request itself does not veto', async () => {
    const verdict = await classify(
      'Please find attached the further information request. The applicant is requested to ' +
      'submit a noise impact assessment prepared by a suitably qualified person.',
      'cover-letter.pdf'
    );
    expect(verdict.isResponse).toBe(false);
  });
});

describe('classifyFIResponse - council reports named like deliverables', () => {
  // Irish councils publish internal consultee reports under names that read as
  // deliverables. Vetoing on the filename alone suppressed live leads.
  test('PRODUCTION 383115: "Air_and_Noise_Report.pdf" that asks for an NIA is a lead', async () => {
    const verdict = await classify(
      'given the residential setting, potential noise impacts from the proposed commercial ' +
      'activity on the neighbouring residential proper ties should be assessed, and the ' +
      'following additional information should be requested from the applicant: 1. a noise ' +
      'impact assessment ( nia) shall be carried out by the applicant',
      '015d16d32ce9f11cc9190e62c24b686c-FW25A.0216E_Air_and_Noise_Report.pdf'
    );
    expect(verdict.isResponse).toBe(false);
  });

  test('PRODUCTION 383519: a report noting the NIA has NOT been submitted is a lead', async () => {
    const verdict = await classify(
      'the location of these proposed facil ities is adjacent to an area of existing ' +
      'residential housing , however t he applicant has not submitted any noise impact ' +
      'assessment outlining the noise expected to be generated by the se new activities',
      '77db92232a068e49c2dda5e6f4d0b3e3-F25A.0469E_Air_and_Noise_Report.pdf'
    );
    expect(verdict.isResponse).toBe(false);
  });

  test('PRODUCTION 385420: "noise_assessment.pdf" that requests one is a lead', async () => {
    const verdict = await classify(
      'the applicant is requested to submit a noise impact assessment carried out by a ' +
      'qualified person to assess the noise expected to be generated by the proposed development',
      'ddec8223b428e152b176bbc82734b717-airside_leisure_centre_noise_assessment.pdf'
    );
    expect(verdict.isResponse).toBe(false);
  });

  test('PRODUCTION 389452: OCR-split "recommend s that" is still a request', async () => {
    const verdict = await classify(
      'in order to mitigate against noise , the air and noise unit recommend s that the ' +
      'following additional information be requested from the applicant: 1. t he applicant ' +
      'shall complete a noise impact assessment report, including baseline noise monitoring',
      '08613bf6c46b1aea45d7f76c3037e53c-F25A.0689E_Air_and_Noise_report.pdf'
    );
    expect(verdict.isResponse).toBe(false);
  });

  test('PRODUCTION 418804: a file named Request-for-Further-Information is never vetoed on weak markers', async () => {
    // "the submitted environmental audit" is not the acoustic report, and the filename
    // says outright what the document is.
    const verdict = await classify(
      'provide details of all 2025 and to date 2026, noise monitoring reports and results. ' +
      'it is noted that the submitted environmental audit 2024/2025, details 2024 noise ' +
      'results as per section 3.2.1. of same.',
      '507799cb6d9988abd57dbaa589af8324-261573-Request-for-Further-Information.pdf'
    );
    expect(verdict.isResponse).toBe(false);
  });

  test('PRODUCTION 307302: a Further Environmental Information request is a lead', async () => {
    const verdict = await classify(
      'cumulative assessment the submitted cumulative noise assessment assumes the ' +
      'repowering of corkey wind farm and does not assess a scenario in which the existing ' +
      'corkey turbines continue to operate concurrently with the proposed development',
      'spd20230951f-carnbuck-wind-farm---fei-request-2026.pdf'
    );
    expect(verdict.isResponse).toBe(false);
  });

  test('a response filename still wins over request language in the body', async () => {
    // An FI response quotes the request it answers, so body request language must not
    // exempt a file that explicitly says it is the response.
    const verdict = await classify(
      'any details of rock extraction should provide details with regard to any related ' +
      'noise, vibration and dust impacts',
      '926ac4ede31af9bf000e451688d88ffc-25-163firesponseletter.pdf'
    );
    expect(verdict.isResponse).toBe(true);
    expect(verdict.source).toBe('filename');
  });

  test('PRODUCTION 403501: OCR-split "respond s to" is still detected', async () => {
    // The stored text reads "this report respond s to", which no literal phrase match
    // would catch - hence whitespace-insensitive marker matching.
    const verdict = await classify(
      'this report respond s to items relating to noise within the request for further ' +
      'information (rfi) under council ref. pf/0422/26 . items within the rfi relating to ' +
      'amenity areas and inward noise impacts are addressed in this report.',
      'some-unremarkable-name.pdf'
    );
    expect(verdict.isResponse).toBe(true);
    expect(verdict.source).toBe('hard-marker');
  });
});

describe('classifyFIResponse - the veto is scoped to one report type', () => {
  test('an acoustic response does not veto a transport job', async () => {
    const verdict = await classify(
      'the applicant has provided a noise impact assessment based on the animals proposed',
      'noise-assessment-response.pdf',
      'transport'
    );
    expect(verdict.isResponse).toBe(false);
  });

  test('a transport response does veto a transport job', async () => {
    const verdict = await classify(
      'the applicant has provided a transport assessment for the proposed junction',
      'traffic-note.pdf',
      'transport'
    );
    expect(verdict.isResponse).toBe(true);
  });

  test('ScanJob spelling "ecology" resolves to the same vocabulary as "ecological"', async () => {
    // ScanJob.documentType allows `ecology`; Customer.reportTypes uses `ecological`.
    // Before reportTypes.js these were different vocabularies and never matched.
    expect(normalizeReportType('ecology')).toBe('ecological');
    expect(getQuoteTerms('ecology')).toEqual(getQuoteTerms('ecological'));

    const verdict = await classify(
      'the applicant has provided an ecological impact assessment for the site',
      'eco-note.pdf',
      'ecology'
    );
    expect(verdict.isResponse).toBe(true);
  });
});

describe('classifyFIResponse - AI layer failure must not suppress leads', () => {
  test('an AI error fails open rather than vetoing', async () => {
    const spy = jest.spyOn(fiDetectionService, 'runChat')
      .mockRejectedValue(new Error('rate limited'));

    const verdict = await fiDetectionService.classifyFIResponse(
      'the applicant is requested to carry out a noise assessment',
      'letter.pdf',
      'acoustic',
      { useAI: true }
    );

    expect(verdict.isResponse).toBe(false);
    spy.mockRestore();
  });
});

describe('selectBestMatchPerProject - one row per project and report type', () => {
  const acousticRequest = {
    projectId: '395085',
    fiType: 'acoustic',
    validationQuote: '4 air and noise (a) the applicant is requested to carry out a noise assessment for the proposed residential units',
    confidence: 0.95,
    timestamp: new Date('2026-08-08')
  };

  test('PRODUCTION 395085: three matched files collapse to the strongest one', () => {
    const selected = scanJobProcessor.selectBestMatchPerProject([
      { ...acousticRequest, validationQuote: 'No quote captured' },
      { ...acousticRequest, validationQuote: 'air and noise' },
      acousticRequest
    ], 'acoustic');

    expect(selected).toHaveLength(1);
    expect(selected[0].validationQuote).toBe(acousticRequest.validationQuote);
  });

  test('PRODUCTION 390717: OCR variants of one quote collapse to the fuller text', () => {
    const truncated = 'the applicant shall carry out a noise assessment for t he proposed development';
    const full = 'the applicant shall carry out a noise assessment for the proposed development and detail the appropriate measures to limit the impact of traffic generated noise';

    const selected = scanJobProcessor.selectBestMatchPerProject([
      { projectId: '390717', fiType: 'acoustic', validationQuote: truncated, confidence: 0.95, timestamp: new Date('2026-08-08') },
      { projectId: '390717', fiType: 'acoustic', validationQuote: full, confidence: 0.95, timestamp: new Date('2026-08-08') }
    ], 'acoustic');

    expect(selected).toHaveLength(1);
    expect(selected[0].validationQuote).toBe(full);
  });

  test('a placeholder quote never outranks real evidence', () => {
    const selected = scanJobProcessor.selectBestMatchPerProject([
      { projectId: '1', fiType: 'acoustic', validationQuote: 'Match confirmed by AI', confidence: 0.99, timestamp: new Date('2026-01-01') },
      { projectId: '1', fiType: 'acoustic', validationQuote: 'the applicant is requested to submit a noise impact assessment', confidence: 0.5, timestamp: new Date('2026-01-02') }
    ], 'acoustic');

    expect(selected).toHaveLength(1);
    expect(selected[0].validationQuote).toMatch(/requested to submit/);
  });

  test('different report types for one project stay separate', () => {
    const selected = scanJobProcessor.selectBestMatchPerProject([
      { projectId: '7', fiType: 'acoustic', validationQuote: 'the applicant is requested to submit a noise assessment', confidence: 0.95 },
      { projectId: '7', fiType: 'transport', validationQuote: 'the applicant is requested to submit a transport assessment', confidence: 0.95 }
    ], 'acoustic');

    expect(selected).toHaveLength(2);
  });
});
