/**
 * @ngdoc Directives
 * @name form-for
 * @description
 * This directive should be paired with an Angular ngForm object and should contain at least one of the formFor field types described below.
 * At a high level, it operates on a bindable form-data object and runs validations each time a change is detected.
 *
 * @param {Object} controller Two way bindable attribute exposing access to the formFor controller API.
 * See below for an example of how to use this binding to access the controller.
 * @param {Boolean} disable Form is disabled.
 * (Note the name is disable and not disabled to avoid collisions with the HTML5 disabled attribute).
 * This attribute is 2-way bindable.
 * @param {Object} formFor An object on $scope that formFor should read and write data to.
 * To prevent accidentally persisting changes to this object after a cancelled form, it is recommended that you bind to a copied object.
 * For more information refer to angular.copy.
 * @param {String} service Convenience mehtod for identifying an $injector-accessible model containing both the validation rules and submit function.
 * Validation rules should be accessible via an attribute named validationRules and the submit function should be named submit.
 * @param {Function} submitComplete Custom handler to be invoked upon a successful form submission.
 * Use this to display custom messages or do custom routing after submit.
 * This method should accept a "data" parameter.
 * See below for an example.
 * (To set a global, default submit-with handler see FormForConfiguration.)
 * @param {Function} submitError Custom error handler function.
 * This function should accept an "error" parameter.
 * See below for an example.
 * (To set a global, default submit-with handler see FormForConfiguration.)
 * @param {Function} submitWith Function triggered on form-submit.
 * This function should accept a named parameter data (the model object) and should return a promise to be resolved/rejected based on the result of the submission.
 * In the event of a rejection, the promise can return an error string or a map of field-names to specific errors.
 * See below for an example.
 * @param {Object} validationRules Set of client-side validation rules (keyed by form field names) to apply to form-data before submitting.
 * For more information refer to the Validation Types page.
 */
angular.module('formFor').directive('formFor',
  function($injector, $parse, $q, $sce, FormForConfiguration, $FormForStateHelper, NestedObjectHelper, ModelValidator) {
    return {
      require: 'form',
      restrict: 'A',
      scope: {
        controller: '=?',
        disable: '=?',
        errorMap: '=?',
        formFor: '=',
        service: '@',
        submitComplete: '&?',
        submitError: '&?',
        submitWith: '&?',
        valid: '=?',
        validationRules: '=?'
      },
      controller: function($scope) {

        // Map of safe (bindable, $scope.$watch-able) field names to objects containing the following keys:
        // • bindableWrapper: Shared between formFor and field directives. Returned by registerFormField(). Contains:
        //   • bindable: Used for easier 2-way data binding between formFor and input field
        //   • disabled: Field should be disabled (generally because form-submission is in progress)
        //   • error: Field should display the following validation error message
        //   • required: Informs the field's label if it should show a "required" marker
        // • fieldName: Original field name
        // • unwatchers: Array of unwatch functions to be invoked on field-unregister
        // • validationAttribute: Maps field name to the location of field validation rules
        //
        // A note on safe field names:
        // A field like 'hobbies[0].name' might be mapped to something like 'hobbies__0__name' so that we can safely $watch it.
        $scope.fields = {};

        // Set of bindable wrappers used to disable buttons when form-submission is in progress.
        // Wrappers contain the following keys:
        //   • disabled: Button should be disabled (generally because form-submission is in progress)
        //
        // Note that there is no current way to associate a wrapper with a button.
        $scope.buttons = [];

        if ($scope.service) {
          $scope.$service = $injector.get($scope.service);
        }

        // Validation rules can come through 2 ways:
        // As part of the validation service or as a direct binding.
        if ($scope.$service) {
          $scope.$validationRules = $scope.$service.validationRules;
        } else {
          $scope.$validationRules = $scope.validationRules;
        }

        // Attaching controller methods to a 'controller' object instead of 'this' results in prettier JSDoc display.
        var controller = this;

        /**
         * All form-input children of formFor must register using this function.
         * @memberof form-for
         * @param {String} fieldName Unique identifier of field within model; used to map errors back to input fields
         * @return {Object} Object containing keys to be observed by the input field:
         * • bindable: Input should 2-way bind against this attribute in order to sync data with formFor.
         * • disabled: Input should disable itself if this value becomes true; typically this means the form is being submitted.
         * • error: Input should display the string contained in this field (if one exists); this means the input value is invalid.
         * • required: Input should display a 'required' indicator if this value is true.
         */
        controller.registerFormField = function(fieldName) {
          var bindableFieldName = NestedObjectHelper.flattenAttribute(fieldName);
          var rules = NestedObjectHelper.readAttribute($scope.$validationRules, fieldName);

          // Store information about this field that we'll need for validation and binding purposes.
          // @see Above documentation for $scope.fields
          var fieldDatum = {
            bindableWrapper: {
              bindable: null,
              disabled: false,
              error: null,
              required: ModelValidator.isFieldRequired(fieldName, $scope.validationRules)
            },
            fieldName: fieldName,
            unwatchers: [],
            validationAttribute: fieldName.split('[')[0]
          };

          $scope.fields[bindableFieldName] = fieldDatum;

          var getter = $parse(fieldName);
          var setter = getter.assign;

          // Changes made by our field should be synced back to the form-data model.
          fieldDatum.unwatchers.push(
            $scope.$watch('fields.' + bindableFieldName + '.bindableWrapper.bindable', function(newValue, oldValue) {
              if (newValue !== oldValue) {
                setter($scope.formFor, newValue);
              }
            }));

          var formDataWatcherInitialized;

          // Changes made to the form-data model should likewise be synced to the field's bindable model.
          // (This is necessary for data that is loaded asynchronously after a form has already been displayed.)
          fieldDatum.unwatchers.push(
            $scope.$watch('formFor.' + fieldName, function(newValue, oldValue) {
              fieldDatum.bindable = getter($scope.formFor);

              // Changes in form-data should also trigger validations.
              // Validation failures will not be displayed unless the form-field has been marked dirty (changed by user).
              // We shouldn't mark our field as dirty when Angular auto-invokes the initial watcher though,
              // So we ignore the first invocation...
              if (!formDataWatcherInitialized) {
                formDataWatcherInitialized = true;

              // If formFor was binded with an empty object, ngModel will auto-initialize keys on blur.
              // We shouldn't treat this as a user-edit though unless the user actually typed something.
              // It's possible they typed and then erased, but that seems less likely.
              // So we also shouldn't mark as dirty unless a truthy value has been provided.
              } else if (oldValue !== undefined || newValue !== '') {
                $scope.formForStateHelper.setFieldHasBeenModified(bindableFieldName, true);
              }

              // Run validations and store the result keyed by our bindableFieldName for easier subsequent lookup.
              if ($scope.$validationRules) {
                ModelValidator.validateField(
                    $scope.formFor,
                    fieldName,
                    $scope.$validationRules
                  ).then(
                      function() {
                        $scope.formForStateHelper.setFieldError(bindableFieldName, null);
                      },
                      function(error) {
                        $scope.formForStateHelper.setFieldError(bindableFieldName, error);
                      });
              }
            }));

          return fieldDatum.bindableWrapper;
        };

        /**
         * Form fields created within ngRepeat or ngIf directive should clean up themselves on removal.
         * @memberof form-for
         * @param {String} fieldName Unique identifier of field within model; used to map errors back to input fields
         */
        this.unregisterFormField = function(fieldName) {
          var bindableFieldName = NestedObjectHelper.flattenAttribute(fieldName);

          angular.forEach(
            $scope.fields[bindableFieldName].unwatchers,
            function(unwatch) {
              unwatch();
            });
        };

        /**
         * All submitButton children must register with formFor using this function.
         * @memberof form-for
         * @param {$scope} submitButtonScope $scope of submit button directive
         * @return {Object} Object containing keys to be observed by the input button:
         * • disabled: Button should disable itself if this value becomes true; typically this means the form is being submitted.
         */
        controller.registerSubmitButton = function(submitButtonScope) {
          var bindableWrapper = {
            disabled: false
          };

          $scope.buttons.push(bindableWrapper);

          return bindableWrapper;
        };

        /**
         * Resets errors displayed on the <form> without resetting the form data values.
         * @memberof form-for
         */
        controller.resetErrors = function() {
          $scope.formForStateHelper.setFormSubmitted(false);

          var keys = NestedObjectHelper.flattenObjectKeys($scope.errorMap);

          angular.forEach(keys, function(fieldName) {
            $scope.formForStateHelper.setFieldHasBeenModified(fieldName, false);
          });
        };

        // Expose controller methods to the $scope.controller interface
        $scope.controller = $scope.controller || {};
        $scope.controller.registerFormField = this.registerFormField;
        $scope.controller.registerSubmitButton = this.registerSubmitButton;
        $scope.controller.resetErrors = this.resetErrors;
        $scope.controller.unregisterFormField = this.unregisterFormField;

        // Disable all child inputs if the form becomes disabled.
        $scope.$watch('disable', function(value) {
          angular.forEach($scope.fields, function(field) {
            field.bindableWrapper.disabled = value;
          });

          angular.forEach($scope.buttons, function(wrapper) {
            wrapper.disabled = value;
          });
        });

        // Track field validity and dirty state.
        $scope.formForStateHelper = new $FormForStateHelper($scope);

        // Watch for any validation changes or changes in form-state that require us to notify the user.
        // Rather than using a deep-watch, FormForStateHelper exposes a bindable attribute 'watchable'.
        // This attribute is gauranteed to change whenever validation criteria change (but its value is meaningless).
        $scope.$watch('formForStateHelper.watchable', function() {
          var hasFormBeenSubmitted = $scope.formForStateHelper.hasFormBeenSubmitted();

          angular.forEach($scope.fields, function(fieldDatum, bindableFieldName) {
            if (hasFormBeenSubmitted || $scope.formForStateHelper.hasFieldBeenModified(bindableFieldName)) {
              var error = $scope.formForStateHelper.getFieldError(bindableFieldName);

              fieldDatum.bindableWrapper.error = error ? $sce.trustAsHtml(error) : null;
            } else {
              fieldDatum.bindableWrapper.error = null; // Clear out field errors in the event that the form has been reset.
            }
          });
        });

        /*
         * Update all registered form fields with the specified error messages.
         * Specified map should be keyed with fieldName and should container user-friendly error strings.
         * @param {Object} errorMap Map of field names (or paths) to errors
         */
        $scope.updateErrors = function(errorMap) {
          angular.forEach($scope.fields, function(scope, bindableFieldName) {
            var error = NestedObjectHelper.readAttribute(errorMap, bindableFieldName);

            $scope.formForStateHelper.setFieldError(bindableFieldName, error);
          });
        };

        /*
         * Validate all registered fields and update FormForStateHelper's error mapping.
         * This update indirectly triggers form validity check and inline error message display.
         */
        $scope.validateAll = function() {
          $scope.updateErrors({}); // Reset errors before starting new validation.

          var validationPromise;

          if ($scope.$validationRules) {
            var validationKeys = [];

            angular.forEach($scope.fields, function(field) {

              // Only validate collections once
              if (validationKeys.indexOf(field.validationAttribute) < 0) {
                validationKeys.push(field.validationAttribute);
              }
            });

            validationPromise = ModelValidator.validateFields($scope.formFor, validationKeys, $scope.$validationRules);
          } else {
            validationPromise = $q.resolve();
          }

          validationPromise.then(angular.noop, $scope.updateErrors);

          return validationPromise;
        };
      },
      link: function($scope, $element, $attributes, controller) {
        $element.on('submit', // Override form submit to trigger overall validation.
          function() {
            $scope.formForStateHelper.setFormSubmitted(true);
            $scope.disable = true;

            $scope.validateAll().then(
              function(response) {
                var promise;

                // $scope.submitWith is wrapped with a virtual function so we must check via attributes
                if ($attributes.submitWith) {
                  promise = $scope.submitWith({data: $scope.formFor});
                } else if ($scope.$service && $scope.$service.submit) {
                  promise = $scope.$service.submit($scope.formFor);
                } else {
                  promise = $q.reject('No submit function provided');
                }

                // Issue #18 Guard against submit functions that don't return a promise by warning rather than erroring.
                if (!promise) {
                  promise = $q.reject('Submit function did not return a promise');
                }

                promise.then(
                  function(response) {
                    // $scope.submitComplete is wrapped with a virtual function so we must check via attributes
                    if ($attributes.submitComplete) {
                      $scope.submitComplete({data: response});
                    } else {
                      FormForConfiguration.defaultSubmitComplete(response);
                    }
                  },
                  function(errorMessageOrErrorMap) {
                    // If the remote response returned inline-errors update our error map.
                    // This is unecessary if a string was returned.
                    if (angular.isObject(errorMessageOrErrorMap)) {
                      $scope.updateErrors(errorMessageOrErrorMap);
                    }

                    // $scope.submitError is wrapped with a virtual function so we must check via attributes
                    if ($attributes.submitError) {
                      $scope.submitError({error: errorMessageOrErrorMap});
                    } else {
                      FormForConfiguration.defaultSubmitError(errorMessageOrErrorMap);
                    }
                  });
                promise['finally'](
                  function() {
                    $scope.disable = false;
                  });
              },
              function() {
                $scope.disable = false;
              });

          return false;
        });
      }
    };
  });
