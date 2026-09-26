"""Shared Cycles / colour settings for previews and the final walkthrough."""


def configure(sc, size, samples, threshold=None, clamp_indirect=8.0, min_samples=16):
    """`threshold` None means every pixel gets exactly `samples` samples.
    Uniform sampling keeps the noise level (and so the denoiser's behaviour)
    identical from frame to frame; adaptive sampling decides per frame."""
    sc.render.engine = 'CYCLES'
    cy = sc.cycles
    cy.device = 'CPU'
    cy.samples = samples
    cy.use_adaptive_sampling = threshold is not None
    if threshold is not None:
        cy.adaptive_threshold = threshold
        cy.adaptive_min_samples = min(min_samples, samples)
    cy.use_denoising = True
    cy.denoiser = 'OPENIMAGEDENOISE'
    cy.denoising_input_passes = 'RGB_ALBEDO_NORMAL'
    cy.denoising_prefilter = 'ACCURATE'
    cy.denoising_quality = 'HIGH'
    cy.max_bounces = 8
    cy.diffuse_bounces = 3
    cy.glossy_bounces = 2
    cy.transmission_bounces = 6
    cy.transparent_max_bounces = 8
    cy.volume_bounces = 0
    cy.caustics_reflective = False
    cy.caustics_refractive = False
    cy.blur_glossy = 1.0
    # Indirect firefly clamp. 8 is the value the look was built with; lower
    # values measurably dim the sunlit kitchen, so it stays unchanged.
    cy.sample_clamp_indirect = clamp_indirect
    cy.use_light_tree = True
    # fixed seed, never animated: frames are fully deterministic
    cy.seed = 7
    cy.use_animated_seed = False
    cy.pixel_filter_type = 'BLACKMAN_HARRIS'
    cy.filter_width = 1.5
    sc.render.resolution_x, sc.render.resolution_y = size
    sc.render.resolution_percentage = 100
    sc.render.film_transparent = False
    sc.render.use_persistent_data = True
    sc.render.image_settings.file_format = 'PNG'
    sc.render.image_settings.color_depth = '8'
    sc.view_settings.view_transform = 'AgX'
    sc.view_settings.look = 'AgX - Base Contrast'
    sc.render.threads_mode = 'AUTO'
